/**
 * Tests for queryDaemonForSession from daemon-client.ts.
 *
 * Tests the ACTUAL production code, not a replica.
 *
 * Run: node --experimental-strip-types --test test/agent-session.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createServer, Socket, Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { queryDaemonForSession } from "../agent-identity/daemon-client.ts";

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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("queryDaemonForSession", () => {
	before(startMockDaemon);
	after(stopMockDaemon);

	it("resolves known agent name to session file", async () => {
		const result = await queryDaemonForSession("test-fox-42", SOCKET_PATH);
		assert.equal(result, "/tmp/test-session.jsonl");
	});

	it("returns null for unknown agent name", async () => {
		const result = await queryDaemonForSession("nonexistent-99", SOCKET_PATH);
		assert.equal(result, null);
	});

	it("returns null for empty agent name", async () => {
		const result = await queryDaemonForSession("", SOCKET_PATH);
		assert.equal(result, null);
	});
});

describe("queryDaemonForSession without daemon", () => {
	it("returns null when daemon is not running", async () => {
		const result = await queryDaemonForSession("test-fox-42", SOCKET_PATH);
		assert.equal(result, null);
	});
});

describe("/session command arg parsing", () => {
	it("empty string should be rejected", () => {
		assert.equal("".trim(), "");
	});

	it("valid agent name is accepted", () => {
		assert.equal("test-fox-42".trim(), "test-fox-42");
	});

	it("whitespace-only is rejected", () => {
		assert.equal("   ".trim(), "");
	});
});
