#!/usr/bin/env node
/**
 * Agent Identity Daemon
 *
 * Standalone singleton daemon that polls GitHub PRs and Linear for @mentions
 * of AI agent names. Pi sessions register via Unix socket; the daemon delivers
 * mentions in real-time or resumes disconnected sessions.
 *
 * Start:   npx tsx daemon.ts
 * Stop:    kill $(cat /tmp/agent-identity-daemon.pid)
 * Socket:  /tmp/agent-identity-daemon.sock
 * Log:     /tmp/agent-identity-daemon.log
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execSync } from "node:child_process";

// ─── Constants ──────────────────────────────────────────────────────────────

const PID_FILE = "/tmp/agent-identity-daemon.pid";
const SOCK_FILE = "/tmp/agent-identity-daemon.sock";
const SEEN_FILE = "/tmp/agent-identity-daemon-seen.json";
const LOG_FILE = "/tmp/agent-identity-daemon.log";

const POLL_INTERVAL = Math.max(
  parseInt(process.env["AGENT_IDENTITY_POLL_INTERVAL"] ?? "60", 10) * 1000,
  30_000,
);

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

// ─── Seen mentions persistence ──────────────────────────────────────────────

const seenMentionIds = new Set<number>();

function loadSeen(): void {
  try {
    const raw = fs.readFileSync(SEEN_FILE, "utf-8");
    const data = JSON.parse(raw) as { ids: number[] };
    if (Array.isArray(data.ids)) {
      for (const id of data.ids) {
        if (typeof id === "number") seenMentionIds.add(id);
      }
      log(`Loaded ${seenMentionIds.size} seen mention IDs`);
    }
  } catch {}
}

function saveSeen(): void {
  try {
    const ids = Array.from(seenMentionIds).slice(-2000);
    fs.writeFileSync(SEEN_FILE, JSON.stringify({ ids }), "utf-8");
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

  log(`Registered: ${data.agentName} (session: ${path.basename(data.sessionFile)})${reg.repo ? ` repo: ${reg.repo}` : ""}`);
}

function removeRegistration(agentName: string, sock?: net.Socket): void {
  const reg = registry.get(agentName);
  if (!reg) return;
  if (sock && reg.socket !== sock) return;

  if (reg.socket) socketRegistry.delete(socketKey(reg.socket));
  registry.delete(agentName);
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
    log(`Agent disconnected (revivable): ${reg.agentName}`);
  }
}

function getDistinctRepos(): string[] {
  const repos = new Set<string>();
  for (const reg of registry.values()) {
    if (reg.repo) repos.add(reg.repo);
  }
  return Array.from(repos);
}

// ─── GitHub helpers ─────────────────────────────────────────────────────────

function ghAvailable(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getOpenPrNumbers(owner: string, repo: string): number[] {
  try {
    const raw = execSync(
      `gh pr list --repo "${owner}/${repo}" --state open --json number --jq '.[].number'`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    );
    return raw.trim().split("\n").filter(Boolean).map(Number).filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

interface GhComment {
  id: number;
  body: string;
  user: string | null;
  url: string;
  type: string;
}

function fetchPrComments(owner: string, repo: string, prNumber: number): GhComment[] {
  const comments: GhComment[] = [];

  // Issue comments
  try {
    const raw = execSync(
      `gh api "repos/${owner}/${repo}/issues/${prNumber}/comments" --jq '.[] | {id: .id, body: .body, user: .user.login, url: .html_url, type: "issue"}'`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    );
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try { comments.push(JSON.parse(line) as GhComment); } catch {}
    }
  } catch {}

  // Review comments
  try {
    const raw = execSync(
      `gh api "repos/${owner}/${repo}/pulls/${prNumber}/comments" --jq '.[] | {id: .id, body: .body, user: .user.login, url: .html_url, type: "review"}'`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    );
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try { comments.push(JSON.parse(line) as GhComment); } catch {}
    }
  } catch {}

  return comments;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Polling ────────────────────────────────────────────────────────────────

function poll(): void {
  if (!ghAvailable()) return;

  const repos = getDistinctRepos();
  const envRepo = process.env["AGENT_IDENTITY_REPO"];
  if (repos.length === 0 && envRepo) {
    repos.push(envRepo);
  }
  if (repos.length === 0) return;

  for (const repoFull of repos) {
    const parts = repoFull.split("/");
    if (parts.length !== 2) continue;
    const [owner, repo] = parts as [string, string];

    const prs = getOpenPrNumbers(owner, repo);

    for (const prNumber of prs) {
      const comments = fetchPrComments(owner, repo, prNumber);

      for (const comment of comments) {
        if (seenMentionIds.has(comment.id)) continue;
        if (!comment.body) continue;

        for (const [agentName, reg] of registry) {
          if (!agentName) continue;

          const pattern = new RegExp(`@${escapeRegex(agentName)}\\b`, "i");

          if (pattern.test(comment.body)) {
            seenMentionIds.add(comment.id);

            const from = comment.user ?? "unknown";
            const payload = {
              type: "mention" as const,
              from,
              prNumber,
              body: comment.body.slice(0, 800),
              url: comment.url,
              repo: repoFull,
              agentName,
              commentId: comment.id,
            };

            // Deliver: live if connected, otherwise revive session
            if (reg.connected && reg.socket?.writable) {
              safeWrite(reg.socket, JSON.stringify(payload) + "\n");
              log(`Delivered mention to ${agentName} (live): PR #${prNumber} by @${from}`);
            } else if (!reg.connected) {
              log(`Agent ${agentName} disconnected, attempting session revival...`);
              resumeSession(reg, payload);
            }
            break;
          }
        }
      }
    }
  }

  saveSeen();
}

function resumeSession(reg: Registration, mention: Record<string, unknown>): void {
  if (!reg.sessionFile || !fs.existsSync(reg.sessionFile)) {
    log(`Cannot resume ${reg.agentName}: session file not found`);
    return;
  }

  const msg = [
    `🔔 **You were mentioned by @${mention["from"]}** in PR #${mention["prNumber"]}:`,
    "",
    `> ${(mention["body"] as string).slice(0, 800)}`,
    "",
    `URL: ${mention["url"]}`,
    "",
    `Respond to this mention on GitHub. Identify yourself as ${reg.agentName} and reply to @${mention["from"]} in the PR.`,
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
                seenIds: Array.from(seenMentionIds).slice(-2000),
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

            case "poll_now":
              safeWrite(sock, JSON.stringify({ type: "poll_started" }) + "\n");
              try { poll(); } catch (err) { log(`Poll error: ${err instanceof Error ? err.message : "?"}`); }
              safeWrite(sock, JSON.stringify({ type: "poll_complete" }) + "\n");
              break;

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
  saveSeen();
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

  loadSeen();
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

  log(`Polling every ${POLL_INTERVAL / 1000}s`);

  setTimeout(() => {
    try { poll(); } catch (err) { log(`Poll err: ${err instanceof Error ? err.message : "?"}`); }
  }, 5000);

  setInterval(() => {
    try { poll(); } catch (err) { log(`Poll err: ${err instanceof Error ? err.message : "?"}`); }
  }, POLL_INTERVAL);

  log(`Ready (PID ${process.pid})`);
}

main();
