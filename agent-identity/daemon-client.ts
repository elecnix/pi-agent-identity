/**
 * Daemon client — query the agent-identity daemon for session lookups.
 *
 * Extracted from index.ts so it can be tested directly.
 */

import { createConnection } from "node:net";
import {
	existsSync,
	openSync,
	readSync,
	closeSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseAgentListResponse } from "./name-minting.ts";

const DEFAULT_SOCKET_PATH = "/tmp/agent-identity-daemon.sock";

/**
 * Where pi stores its session files: ~/.pi/agent/sessions/<cwd>/<ts>_<uuid>.jsonl
 * Overridable via PI_SESSIONS_DIR for tests / non-standard installs.
 */
const DEFAULT_SESSIONS_DIR =
	process.env["PI_SESSIONS_DIR"] ?? join(homedir(), ".pi", "agent", "sessions");

export function isDaemonRunning(socketPath: string = DEFAULT_SOCKET_PATH): boolean {
	return existsSync(socketPath);
}

/**
 * Resolve a --agent-name CLI flag value to a session file path.
 *
 * Returns null when the flag is unset, not a string, or matches the current
 * agent name. Otherwise asks the daemon first (fast path for live/known
 * agents) and, if the daemon has no record, falls back to scanning the
 * on-disk session files — the durable source of truth — so an agent can be
 * revived even after a reboot wiped the daemon's /tmp registry.
 */
export async function resolveTargetSession(
	flagValue: string | boolean | undefined,
	currentAgentName: string,
	socketPath: string = DEFAULT_SOCKET_PATH,
	sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<string | null> {
	if (!flagValue || typeof flagValue !== "string") return null;
	if (flagValue === currentAgentName) return null;
	const fromDaemon = await queryDaemonForSession(flagValue, socketPath);
	if (fromDaemon) return fromDaemon;
	return findSessionByAgentName(flagValue, sessionsDir);
}

/**
 * Scan pi session files for the one whose embedded identity matches
 * `agentName`, returning the path of the most recently modified match (or
 * null). Each session records its identity as an early custom entry:
 *   {"type":"custom","customType":"agent-identity-name","data":{"name":"..."}}
 * The entry is written at session_start, so it lives in the file's head — we
 * only read the first chunk of each file rather than the whole thing.
 */
export function findSessionByAgentName(
	agentName: string,
	sessionsDir: string = DEFAULT_SESSIONS_DIR,
): string | null {
	if (!agentName) return null;
	if (!existsSync(sessionsDir)) return null;

	let best: { path: string; mtimeMs: number } | null = null;
	for (const path of listSessionFiles(sessionsDir)) {
		if (!sessionHeadHasName(path, agentName)) continue;
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
	}
	return best?.path ?? null;
}

/** Recursively collect *.jsonl paths under a directory. */
function listSessionFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listSessionFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			out.push(full);
		}
	}
	return out;
}

/** Read the head of a session file and look for the identity entry. */
function sessionHeadHasName(path: string, agentName: string): boolean {
	const head = readHead(path, 65536);
	if (!head) return false;
	// Cheap reject before parsing — the marker must be present at all.
	if (!head.includes("agent-identity-name")) return false;

	const lines = head.split("\n");
	// Drop a possibly-truncated final line from the bounded read.
	lines.pop();
	for (const line of lines) {
		if (!line.includes("agent-identity-name")) continue;
		try {
			const msg = JSON.parse(line) as Record<string, unknown>;
			if (
				msg.type === "custom" &&
				msg.customType === "agent-identity-name" &&
				(msg.data as Record<string, unknown> | undefined)?.name === agentName
			) {
				return true;
			}
		} catch {
			/* ignore malformed lines */
		}
	}
	return false;
}

/** Read up to `maxBytes` from the start of a file as UTF-8, or "" on error. */
function readHead(path: string, maxBytes: number): string {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		const buf = Buffer.alloc(maxBytes);
		const n = readSync(fd, buf, 0, maxBytes, 0);
		return buf.toString("utf-8", 0, n);
	} catch {
		return "";
	} finally {
		closeSync(fd);
	}
}

/**
 * Query the daemon for its full agent registry.
 * Returns `{ name, connected }[]`, or [] when the daemon is unreachable.
 */
export async function listDaemonAgents(
	socketPath: string = DEFAULT_SOCKET_PATH,
): Promise<Array<{ name: string; connected: boolean }>> {
	if (!isDaemonRunning(socketPath)) return [];

	return new Promise((resolve) => {
		const sock = createConnection(socketPath);
		let buffer = "";

		const timeout = setTimeout(() => {
			try { sock.destroy(); } catch {}
			resolve([]);
		}, 2000);

		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ type: "list_agents" })}\n`);
		});

		sock.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line) as Record<string, unknown>;
					if (msg.type === "agent_list") {
						clearTimeout(timeout);
						try { sock.destroy(); } catch {}
						resolve(parseAgentListResponse(msg));
						return;
					}
				} catch { /* ignore parse errors */ }
			}
		});

		sock.on("error", () => {
			clearTimeout(timeout);
			try { sock.destroy(); } catch {}
			resolve([]);
		});

		sock.on("close", () => {
			clearTimeout(timeout);
			resolve([]);
		});
	});
}

/**
 * Query the daemon for an agent's session file path.
 * Connects, sends lookup_agent, returns sessionFile or null.
 */
export async function queryDaemonForSession(
	agentName: string,
	socketPath: string = DEFAULT_SOCKET_PATH,
): Promise<string | null> {
	if (!isDaemonRunning(socketPath)) return null;

	return new Promise((resolve) => {
		const sock = createConnection(socketPath);
		let buffer = "";

		const timeout = setTimeout(() => {
			try { sock.destroy(); } catch {}
			resolve(null);
		}, 2000);

		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ type: "lookup_agent", agentName })}\n`);
		});

		sock.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line) as Record<string, unknown>;
					if (msg.type === "agent_found" && msg.sessionFile) {
						clearTimeout(timeout);
						try { sock.destroy(); } catch {}
						// Validate the session file still exists on disk.
						// Daemon entries can go stale when sessions are pruned
						// or the registry path drifts from the filesystem.
						const path = msg.sessionFile as string;
						resolve(existsSync(path) ? path : null);
						return;
					}
					if (msg.type === "agent_not_found") {
						clearTimeout(timeout);
						try { sock.destroy(); } catch {}
						resolve(null);
						return;
					}
				} catch { /* ignore parse errors */ }
			}
		});

		sock.on("error", () => {
			clearTimeout(timeout);
			try { sock.destroy(); } catch {}
			resolve(null);
		});

		sock.on("close", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}
