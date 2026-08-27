#!/usr/bin/env node
/**
 * Agent Identity Daemon
 *
 * Standalone singleton daemon that tracks agent sessions for revival.
 * Pi sessions register via Unix socket; the daemon delivers intercom
 * messages via session revival when targets are disconnected.
 *
 * Disconnected-but-revivable agents are NOT registered with the intercom
 * broker — they stay hidden from the normal roster list. They remain
 * reachable by name or by their stable ghost id (`agent-<name>`, see
 * ghost-id.ts): agent_search surfaces them, and a message routed here
 * (queue_mention) revives the real session.
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
import { resolveDaemonTarget, toAddressable } from "./daemon-targeting.ts";
import { ghostSessionIdFor } from "./ghost-id.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Protocol version — bump when message format changes. Extension checks this on connect. */
const PROTOCOL_VERSION = 1;

const PID_FILE = "/tmp/agent-identity-daemon.pid";
const SOCK_FILE = "/tmp/agent-identity-daemon.sock";
const LOG_FILE = "/tmp/agent-identity-daemon.log";


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
    const data: Record<string, { sessionFile: string; repo: string | null; cwd?: string | null }> = {};
    for (const [name, reg] of registry) {
      data[name] = { sessionFile: reg.sessionFile, repo: reg.repo, cwd: reg.cwd };
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data), "utf-8");
  } catch {}
}

function loadRegistry(): void {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return;
    const raw = fs.readFileSync(REGISTRY_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, { sessionFile: string; repo: string | null; cwd?: string | null }>;
    for (const [name, info] of Object.entries(data)) {
      if (!registry.has(name)) {
        registry.set(name, {
          agentName: name,
          sessionFile: info.sessionFile,
          socket: null,
          pid: 0,
          repo: info.repo,
          connected: false,
          cwd: info.cwd ?? null,
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
  /** Session working directory — lets the ghost register under the same
   *  name+cwd the live session will present on revival (#7). */
  cwd: string | null;
}

const registry = new Map<string, Registration>();
const socketRegistry = new Map<string, Registration>();

function socketKey(sock: net.Socket): string {
  return `${sock.remoteAddress ?? "?"}:${sock.remotePort ?? 0}`;
}

function addRegistration(
  data: { agentName: string; sessionFile: string; pid: number; repo?: string; cwd?: string },
  sock: net.Socket,
): void {
  const existingCwd = registry.get(data.agentName)?.cwd ?? null;
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
    cwd: data.cwd?.trim() || existingCwd,
  };

  registry.set(data.agentName, reg);
  socketRegistry.set(socketKey(sock), reg);
  saveRegistry();

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
    // Stays hidden from the intercom roster — revival happens when a
    // message is routed here via queue_mention.
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
            cwd?: string;
          };

          switch (msg.type) {
            case "register":
              if (!msg.agentName || !msg.sessionFile || !msg.pid) {
                safeWrite(sock, JSON.stringify({ type: "error", message: "register requires agentName, sessionFile, pid" }) + "\n");
                break;
              }
              addRegistration(
                { agentName: msg.agentName, sessionFile: msg.sessionFile, pid: msg.pid, repo: msg.repo, cwd: msg.cwd },
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
                // Stable broker id the agent presents while offline (#7).
                ...(r.connected ? {} : { ghostSessionId: ghostSessionIdFor(r.agentName) }),
              }));
              safeWrite(sock, JSON.stringify({ type: "agent_list", agents }) + "\n");
              break;
            }

            case "lookup_agent": {
              if (!msg.agentName) {
                safeWrite(sock, JSON.stringify({ type: "error", message: "lookup_agent requires agentName" }) + "\n");
                break;
              }
              // Tolerant lookup: exact name, composite `<name>: <suffix>`,
              // or stable ghost id (`agent-<name>`) so offline agents
              // resolve by name or by the id agent_search advertises.
              const reg = resolveDaemonTarget(msg.agentName, toAddressable(Array.from(registry.values())));
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
                ...(reg.connected ? {} : { ghostSessionId: ghostSessionIdFor(reg.agentName) }),
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
              // Tolerant resolution: exact registry hit, composite
              // `<name>: <suffix>` match (session_rename renames sessions to
              // that form while peers address the bare name), or ghost id
              // for hidden offline agents.
              const target = resolveDaemonTarget(targetName, toAddressable(Array.from(registry.values())));
              if (!target) {
                // Name-resolution miss — report it honestly instead of
                // letting the caller claim an offline/revived peer.
                log(`queue_mention: no roster entry matches "${targetName}"`);
                safeWrite(sock, JSON.stringify({ type: "mention_queued", targetName, method: "unresolved" }) + "\n");
                break;
              }
              if (target.connected) {
                // Still connected — deliver live (the intercom failure was
                // likely just a composite-name miss, not an offline peer).
                safeWrite(target.socket!, JSON.stringify({
                  type: "mention", from: fromName, prNumber: 0,
                  body: `📨 Intercom from ${fromName}: ${body.slice(0, 800)}`,
                  url: "", repo: target.repo ?? "", agentName: target.agentName,
                  commentId: Date.now(),
                }) + "\n");
                safeWrite(sock, JSON.stringify({ type: "mention_queued", targetName, method: "live" }) + "\n");
              } else if (isProcessAlive(target.pid)) {
                // Process alive but unreachable via socket — do NOT spawn a
                // second detached pi on the same session file (two writers).
                log(`Not reviving ${targetName}: process ${target.pid} is alive but not connected`);
                safeWrite(sock, JSON.stringify({ type: "mention_queued", targetName, method: "deferred" }) + "\n");
              } else {
                // Disconnected and dead — revive
                log(`Reviving ${target.agentName} for intercom message from ${fromName}`);
                resumeSession(target, {
                  from: fromName, prNumber: 0,
                  body: `📨 Intercom message from @${fromName}:\n\n${body.slice(0, 800)}\n\nReply using intercom({ action: "reply", message: "..." }).`,
                  url: "", repo: target.repo ?? "", agentName: target.agentName,
                  commentId: Date.now(),
                });
                safeWrite(sock, JSON.stringify({ type: "mention_queued", targetName, method: "revival" }) + "\n");
              }
              break;
            }

            case "version_check": {
              const clientVersion = msg.version as number | undefined;
              if (clientVersion === PROTOCOL_VERSION) {
                safeWrite(sock, JSON.stringify({ type: "version_ok", version: PROTOCOL_VERSION }) + "\n");
              } else {
                safeWrite(sock, JSON.stringify({ type: "version_mismatch", expected: PROTOCOL_VERSION, received: clientVersion }) + "\n");
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
