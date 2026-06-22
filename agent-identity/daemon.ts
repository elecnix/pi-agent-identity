#!/usr/bin/env node
/**
 * Agent Identity Daemon
 *
 * Standalone singleton daemon that tracks agent sessions for revival.
 * Pi sessions register via Unix socket; the daemon delivers intercom
 * messages via session revival when targets are disconnected.
 *
 * Start:   npx tsx daemon.ts
 * Stop:    kill $(cat /tmp/agent-identity-daemon.pid)
 * Socket:  /tmp/agent-identity-daemon.sock
 * Log:     /tmp/agent-identity-daemon.log
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────────────

const PID_FILE = "/tmp/agent-identity-daemon.pid";
const SOCK_FILE = "/tmp/agent-identity-daemon.sock";
const LOG_FILE = "/tmp/agent-identity-daemon.log";

const INTERCOM_BROKER = join(homedir(), ".pi/agent/intercom/broker.sock");

// ─── Intercom broker framing (inlined for standalone daemon) ────────────────

function brokerWrite(sock: net.Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  sock.write(Buffer.concat([header, payload]));
}

// ─── Ghost session manager ──────────────────────────────────────────────────
// Maintains intercom broker connections for disconnected agents so they
// appear online and can receive messages (which trigger session revival).

const ghostSessions = new Map<string, { sock: net.Socket; agentName: string; sessionFile: string }>();

function ghostRegister(agentName: string, sessionFile: string): void {
  if (ghostSessions.has(agentName)) return;
  if (!fs.existsSync(INTERCOM_BROKER)) return; // intercom not running

  const sock = net.createConnection(INTERCOM_BROKER);
  let reader: ReturnType<typeof createBrokerReader>;

  sock.on("connect", () => {
    brokerWrite(sock, {
      type: "register",
      session: {
        name: agentName,
        cwd: process.env["HOME"] ?? "/tmp",
        model: "ghost",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: "💤 revivable",
      },
    });
    log(`Ghost registered in intercom: ${agentName}`);
  });

  reader = createBrokerReader((msg: Record<string, unknown>) => {
    if (msg.type === "send" || msg.type === "ask") {
      const message = msg.message as Record<string, unknown> | undefined;
      const text = message?.content && typeof message.content === "object"
        ? (message.content as Record<string, unknown>).text as string ?? ""
        : "";
      const from = (msg.from as string) ?? "unknown";
      log(`Ghost received intercom ${msg.type} for ${agentName} from ${from}`);
      // Revive the real session
      const reg = registry.get(agentName);
      if (reg) {
        resumeSession(reg, {
          from, prNumber: 0,
          body: `📨 Intercom ${msg.type} from @${from}:\n\n${String(text).slice(0, 800)}\n\nReply using intercom({ action: "reply", message: "..." }).`,
          url: "", repo: reg.repo ?? "", agentName, commentId: Date.now(),
        });
      }
    }
    if (msg.type === "session_joined") {
      // Real session came online — kill ghost
      const session = msg.session as Record<string, unknown> | undefined;
      if (session?.name === agentName) {
        log(`Real session joined for ${agentName}, removing ghost`);
        ghostRemove(agentName);
      }
    }
  }, (err: Error) => {
    log(`Ghost broker error for ${agentName}: ${err.message}`);
    ghostRemove(agentName);
  });

  sock.on("data", (data: Buffer) => reader(data));
  sock.on("close", () => ghostRemove(agentName));
  sock.on("error", () => ghostRemove(agentName));

  ghostSessions.set(agentName, { sock, agentName, sessionFile });
}

function ghostRemove(agentName: string): void {
  const g = ghostSessions.get(agentName);
  if (!g) return;
  ghostSessions.delete(agentName);
  try { g.sock.destroy(); } catch {}
  log(`Ghost removed: ${agentName}`);
}

function createBrokerReader(
  onMessage: (msg: Record<string, unknown>) => void,
  onError: (err: Error) => void,
) {
  let buf = Buffer.alloc(0);
  return (data: Buffer) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        const msg = JSON.parse(payload.toString("utf-8")) as Record<string, unknown>;
        onMessage(msg);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  };
}

// ─── Singleton ──────────────────────────────────────────────────────────────

function ensureSingleton(): boolean {
  try {
    const existingPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(existingPid, 10);
    if (isNaN(pid)) {
      fs.writeFileSync(PID_FILE, String(process.pid));
      return true;
    }
    try {
      process.kill(pid, 0);
      log(`Daemon already running (PID ${pid}), exiting.`);
      return false;
    } catch {
      log(`Stale PID file (${pid} not alive), starting new daemon.`);
      fs.writeFileSync(PID_FILE, String(process.pid));
      return true;
    }
  } catch {
    fs.writeFileSync(PID_FILE, String(process.pid));
    return true;
  }
}

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.error(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ─── Safe socket write (no EPIPE crashes) ───────────────────────────────────

function safeWrite(sock: net.Socket, data: string): void {
  try {
    if (sock.writable && !sock.destroyed) {
      sock.write(data);
    }
  } catch {}
}

// ─── Registry persistence ───────────────────────────────────────────────────

const REGISTRY_FILE = "/tmp/agent-identity-daemon-registry.json";

function saveRegistry(): void {
  try {
    const data: Record<string, { sessionFile: string; repo: string | null }> = {};
    for (const [name, reg] of registry) {
      data[name] = { sessionFile: reg.sessionFile, repo: reg.repo };
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data), "utf-8");
  } catch {}
}

function loadRegistry(): void {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return;
    const raw = fs.readFileSync(REGISTRY_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, { sessionFile: string; repo: string | null }>;
    for (const [name, info] of Object.entries(data)) {
      if (!registry.has(name)) {
        registry.set(name, {
          agentName: name,
          sessionFile: info.sessionFile,
          socket: null,
          pid: 0,
          repo: info.repo,
          connected: false,
        });
      }
    }
    log(`Loaded ${registry.size} agents from registry file`);
  } catch {}
}

// ─── Registry ───────────────────────────────────────────────────────────────

interface Registration {
  agentName: string;
  sessionFile: string;
  socket: net.Socket | null;  // null when disconnected but revivable
  pid: number;
  repo: string | null;
  connected: boolean;
}

const registry = new Map<string, Registration>();
const socketRegistry = new Map<string, Registration>();

function socketKey(sock: net.Socket): string {
  return `${sock.remoteAddress ?? "?"}:${sock.remotePort ?? 0}`;
}

function addRegistration(
  data: { agentName: string; sessionFile: string; pid: number; repo?: string },
  sock: net.Socket,
): void {
  // Replace old registration if exists
  const existing = registry.get(data.agentName);
  if (existing && existing.socket !== sock) {
    log(`Replacing stale registration for ${data.agentName}`);
    try { existing.socket?.end(); } catch {}
  }

  const reg: Registration = {
    agentName: data.agentName,
    sessionFile: data.sessionFile,
    socket: sock,
    pid: data.pid,
    repo: data.repo ?? null,
    connected: true,
  };

  registry.set(data.agentName, reg);
  socketRegistry.set(socketKey(sock), reg);
  saveRegistry();

  // Kill ghost if we had one (real session is back)
  ghostRemove(data.agentName);

  log(`Registered: ${data.agentName} (session: ${path.basename(data.sessionFile)})${reg.repo ? ` repo: ${reg.repo}` : ""}`);
}

function removeRegistration(agentName: string, sock?: net.Socket): void {
  const reg = registry.get(agentName);
  if (!reg) return;
  if (sock && reg.socket !== sock) return;

  if (reg.socket) socketRegistry.delete(socketKey(reg.socket));
  registry.delete(agentName);
  saveRegistry();
  log(`Unregistered: ${agentName}`);
}

function removeBySocket(sock: net.Socket): void {
  const key = socketKey(sock);
  const reg = socketRegistry.get(key);
  if (reg) {
    // Keep in registry for revival, just mark as disconnected
    reg.connected = false;
    reg.socket = null;
    socketRegistry.delete(key);
    saveRegistry();
    log(`Agent disconnected (revivable): ${reg.agentName}`);
    // Create ghost intercom session so agent appears online
    ghostRegister(reg.agentName, reg.sessionFile);
  }
}

// ─── Session revival ───────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resumeSession(reg: Registration, mention: Record<string, unknown>): void {
  if (!reg.sessionFile || !fs.existsSync(reg.sessionFile)) {
    log(`Cannot resume ${reg.agentName}: session file not found`);
    return;
  }

  const msg = [
    `🔔 **Message for @${mention["from"]}**:`,
    "",
    `> ${(mention["body"] as string).slice(0, 800)}`,
  ].join("\n");

  log(`Resuming session for ${reg.agentName}: ${reg.sessionFile}`);

  const child = spawn(
    process.env["PI_CMD"] ?? "pi",
    ["--session", reg.sessionFile, "-p", msg],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AGENT_IDENTITY_NAME: reg.agentName },
    },
  );

  child.unref();
  log(`Spawned pi (PID ${child.pid}) for ${reg.agentName}`);
}

// ─── Socket server ──────────────────────────────────────────────────────────

function startServer(): net.Server {
  try { fs.unlinkSync(SOCK_FILE); } catch {}

  const server = net.createServer((sock) => {
    let buffer = "";

    const addr = `${sock.remoteAddress ?? "?"}:${sock.remotePort ?? 0}`;
    log(`Connection from ${addr}`);

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line) as {
            type: string;
            agentName?: string;
            sessionFile?: string;
            pid?: number;
            repo?: string;
          };

          switch (msg.type) {
            case "register":
              if (!msg.agentName || !msg.sessionFile || !msg.pid) {
                safeWrite(sock, JSON.stringify({ type: "error", message: "register requires agentName, sessionFile, pid" }) + "\n");
                break;
              }
              addRegistration(
                { agentName: msg.agentName, sessionFile: msg.sessionFile, pid: msg.pid, repo: msg.repo },
                sock,
              );
              safeWrite(sock, JSON.stringify({
                type: "ack",
                agentName: msg.agentName,
              }) + "\n");
              break;

            case "unregister":
              if (!msg.agentName) {
                safeWrite(sock, JSON.stringify({ type: "error", message: "unregister requires agentName" }) + "\n");
                break;
              }
              removeRegistration(msg.agentName, sock);
              safeWrite(sock, JSON.stringify({ type: "unregistered", agentName: msg.agentName }) + "\n");
              break;

            case "ping":
              safeWrite(sock, JSON.stringify({ type: "pong" }) + "\n");
              break;

            case "list_agents": {
              const agents = Array.from(registry.values()).map(r => ({
                name: r.agentName,
                connected: r.connected,
                repo: r.repo,
              }));
              safeWrite(sock, JSON.stringify({ type: "agent_list", agents }) + "\n");
              break;
            }

            case "lookup_agent": {
              if (!msg.agentName) {
                safeWrite(sock, JSON.stringify({ type: "error", message: "lookup_agent requires agentName" }) + "\n");
                break;
              }
              const reg = registry.get(msg.agentName);
              if (!reg) {
                safeWrite(sock, JSON.stringify({ type: "agent_not_found", agentName: msg.agentName }) + "\n");
                break;
              }
              const active = reg.connected || isProcessAlive(reg.pid);
              safeWrite(sock, JSON.stringify({
                type: "agent_found",
                name: reg.agentName,
                sessionFile: reg.sessionFile,
                connected: reg.connected,
                pid: reg.pid,
                active,
                repo: reg.repo,
              }) + "\n");
              break;
            }

            case "queue_mention": {
              // Route an intercom message directly to daemon for session revival
              const targetName = msg.targetName as string | undefined;
              const fromName = msg.fromName as string | undefined;
              const body = msg.body as string | undefined;
              if (!targetName || !fromName || !body) {
                safeWrite(sock, JSON.stringify({ type: "error", message: "queue_mention requires targetName, fromName, body" }) + "\n");
                break;
              }
              const target = registry.get(targetName);
              if (!target) {
                safeWrite(sock, JSON.stringify({ type: "error", message: `Agent ${targetName} not registered` }) + "\n");
                break;
              }
              if (target.connected) {
                // Still connected — deliver live
                safeWrite(target.socket!, JSON.stringify({
                  type: "mention", from: fromName, prNumber: 0,
                  body: `📨 Intercom from ${fromName}: ${body.slice(0, 800)}`,
                  url: "", repo: target.repo ?? "", agentName: targetName,
                  commentId: Date.now(),
                }) + "\n");
                safeWrite(sock, JSON.stringify({ type: "mention_queued", targetName, method: "live" }) + "\n");
              } else {
                // Disconnected — revive directly
                log(`Reviving ${targetName} for intercom message from ${fromName}`);
                resumeSession(target, {
                  from: fromName, prNumber: 0,
                  body: `📨 Intercom message from @${fromName}:\n\n${body.slice(0, 800)}\n\nReply using intercom({ action: "reply", message: "..." }).`,
                  url: "", repo: target.repo ?? "", agentName: targetName,
                  commentId: Date.now(),
                });
                safeWrite(sock, JSON.stringify({ type: "mention_queued", targetName, method: "revival" }) + "\n");
              }
              break;
            }

            default:
              safeWrite(sock, JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` }) + "\n");
          }
        } catch (err) {
          safeWrite(sock, JSON.stringify({
            type: "error",
            message: `Parse: ${err instanceof Error ? err.message : "?"}`,
          }) + "\n");
        }
      }
    });

    sock.on("close", () => {
      log(`Connection closed: ${addr}`);
      removeBySocket(sock);
    });

    sock.on("error", (err: Error) => {
      log(`Socket error ${addr}: ${err.message}`);
      removeBySocket(sock);
    });
  });

  server.on("error", (err: Error) => {
    log(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(SOCK_FILE, () => {
    log(`Listening on ${SOCK_FILE} (PID ${process.pid})`);
  });

  return server;
}

// ─── Signal handling ────────────────────────────────────────────────────────

function cleanup(server: net.Server): void {
  log("Shutting down...");
  for (const [name] of ghostSessions) ghostRemove(name);
  for (const reg of registry.values()) {
    if (reg.socket) try { reg.socket.end(); } catch {}
  }
  server.close();
  try { fs.unlinkSync(SOCK_FILE); } catch {}
  saveRegistry();
  try { fs.unlinkSync(PID_FILE); } catch {}
  log("Stopped.");
  process.exit(0);
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  log("Agent Identity Daemon starting...");

  if (!ensureSingleton()) {
    process.exit(0);
  }

  loadRegistry();
  const server = startServer();

  process.on("SIGTERM", () => cleanup(server));
  process.on("SIGINT", () => cleanup(server));
  process.on("SIGHUP", () => cleanup(server));

  process.on("uncaughtException", (err: Error) => {
    // Suppress EPIPE errors from disconnected sockets (nc closes immediately)
    if ('code' in err && (err as any).code === 'EPIPE') return;
    if (err.message?.includes('EPIPE')) return;
    log(`Uncaught: ${err.message}`);
  });

  log(`Ready (PID ${process.pid})`);
}

main();
