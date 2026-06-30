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
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { queryDaemonForSession, resolveTargetSession } from "../agent-identity/daemon-client.ts";

const SOCKET_PATH = "/tmp/agent-identity-daemon-test.sock";
const TEST_SESSION_FILE = "/tmp/agent-identity-daemon-test-session.jsonl";

// ─── Mock daemon ──────────────────────────────────────────────────────────

let server: Server | null = null;

function startMockDaemon(): Promise<void> {
	return new Promise((resolve, reject) => {
		try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {}
		// Create a real file so existsSync validation in queryDaemonForSession passes
		writeFileSync(TEST_SESSION_FILE, '{"type":"test"}\n');

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
									sessionFile: TEST_SESSION_FILE,
									connected: true,
									pid: 12345,
									active: true,
									repo: "test/repo",
								}) + "\n");
							} else if (msg.agentName === "stale-badger-1") {
								// Returns a path that does not exist on disk — simulates
								// a stale daemon entry whose session file was deleted.
								sock.write(JSON.stringify({
									type: "agent_found",
									name: "stale-badger-1",
									sessionFile: "/tmp/does-not-exist.jsonl",
									connected: false,
									pid: 0,
									active: false,
									repo: null,
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
				try { unlinkSync(TEST_SESSION_FILE); } catch {}
				server = null;
				resolve();
			});
		} else {
			try { unlinkSync(TEST_SESSION_FILE); } catch {}
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
		assert.equal(result, TEST_SESSION_FILE);
	});

	it("returns null for unknown agent name", async () => {
		const result = await queryDaemonForSession("nonexistent-99", SOCKET_PATH);
		assert.equal(result, null);
	});

	it("returns null for empty agent name", async () => {
		const result = await queryDaemonForSession("", SOCKET_PATH);
		assert.equal(result, null);
	});

	it("returns null when daemon returns a path to a non-existent file (stale entry)", async () => {
		const result = await queryDaemonForSession("stale-badger-1", SOCKET_PATH);
		assert.equal(result, null);
	});
});

describe("queryDaemonForSession without daemon", () => {
	it("returns null when daemon is not running", async () => {
		const result = await queryDaemonForSession("test-fox-42", SOCKET_PATH);
		assert.equal(result, null);
	});
});

describe("resolveTargetSession", () => {
	before(startMockDaemon);
	after(stopMockDaemon);

	it("returns null when flag is undefined", async () => {
		const result = await resolveTargetSession(undefined, "polar-lemur-69", SOCKET_PATH);
		assert.equal(result, null);
	});

	it("returns null when flag is not a string (boolean)", async () => {
		const result = await resolveTargetSession(true, "polar-lemur-69", SOCKET_PATH);
		assert.equal(result, null);
	});

	it("returns null when flag matches current agent name", async () => {
		const result = await resolveTargetSession("solar-falcon-55", "solar-falcon-55", SOCKET_PATH);
		assert.equal(result, null);
	});

	it("resolves session file when flag differs and agent exists in daemon", async () => {
		const result = await resolveTargetSession("test-fox-42", "polar-lemur-69", SOCKET_PATH);
		assert.equal(result, TEST_SESSION_FILE);
	});

	it("returns null when flag differs but agent not found in daemon", async () => {
		const result = await resolveTargetSession("nonexistent-99", "polar-lemur-69", SOCKET_PATH);
		assert.equal(result, null);
	});
});


