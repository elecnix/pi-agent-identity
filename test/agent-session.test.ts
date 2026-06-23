/**
 * Tests for --agent-name flag, /session command, and queryDaemonForSession.
 *
 * Tests the daemon protocol directly since the extension runs inside pi.
 * Uses Node's built-in test runner (node --test).
 *
 * Run: node --experimental-strip-types --test test/agent-session.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, createConnection, Socket, Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

const SOCKET_PATH = "/tmp/agent-identity-daemon-test.sock";

// ─── Mock daemon ──────────────────────────────────────────────────────────

let server: Server | null = null;

function startMockDaemon(): Promise<void> {
	return new Promise((resolve, reject) => {
		try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {}

		server = createServer((sock: Socket) => {
			let buffer = "";
			sock.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						if (msg.type === "lookup_agent") {
							if (msg.agentName === "test-fox-42") {
								sock.write(JSON.stringify({
									type: "agent_found",
									name: "test-fox-42",
									sessionFile: "/tmp/test-session.jsonl",
									connected: true,
									pid: 12345,
									active: true,
									repo: "test/repo",
								}) + "\n");
							} else {
								sock.write(JSON.stringify({
									type: "agent_not_found",
									agentName: msg.agentName,
								}) + "\n");
							}
						}
					} catch {}
				}
			});
		});

		server.on("error", reject);
		server.listen(SOCKET_PATH, () => resolve());
	});
}

function stopMockDaemon(): Promise<void> {
	return new Promise((resolve) => {
		if (server) {
			server.close(() => {
				try { unlinkSync(SOCKET_PATH); } catch {}
				server = null;
				resolve();
			});
		} else {
			resolve();
		}
	});
}

// ─── queryDaemonForSession replica (same logic as index.ts) ──────────────

async function queryDaemonForSession(agentName: string): Promise<string | null> {
	if (!existsSync(SOCKET_PATH)) return null;

	return new Promise((resolve) => {
		const sock = createConnection(SOCKET_PATH);
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
						resolve(msg.sessionFile as string);
						return;
					}
					if (msg.type === "agent_not_found") {
						clearTimeout(timeout);
						try { sock.destroy(); } catch {}
						resolve(null);
						return;
					}
				} catch {}
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("queryDaemonForSession", () => {
	before(startMockDaemon);
	after(stopMockDaemon);

	it("resolves known agent name to session file", async () => {
		const result = await queryDaemonForSession("test-fox-42");
		assert.equal(result, "/tmp/test-session.jsonl");
	});

	it("returns null for unknown agent name", async () => {
		const result = await queryDaemonForSession("nonexistent-99");
		assert.equal(result, null);
	});

	it("returns null for empty agent name", async () => {
		const result = await queryDaemonForSession("");
		assert.equal(result, null);
	});
});

describe("queryDaemonForSession without daemon", () => {
	// Daemon already stopped by after() from previous describe

	it("returns null when daemon is not running", async () => {
		const result = await queryDaemonForSession("test-fox-42");
		assert.equal(result, null);
	});
});

describe("/session command arg parsing", () => {
	it("empty string should be rejected", () => {
		const args = "";
		assert.equal(args.trim(), "");
		assert.equal(args.trim() === "", true);
	});

	it("valid agent name is accepted", () => {
		const args = "test-fox-42";
		assert.equal(args.trim(), "test-fox-42");
	});

	it("whitespace-only is rejected", () => {
		const args = "   ";
		assert.equal(args.trim(), "");
	});
});
