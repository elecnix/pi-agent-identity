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
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	queryDaemonForSession,
	resolveTargetSession,
	findSessionByAgentName,
} from "../agent-identity/daemon-client.ts";

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

// ─── Filesystem fallback ─────────────────────────────────────────────────────

/**
 * Build a fake pi sessions tree with jsonl files that embed an
 * `agent-identity-name` custom entry, mirroring the real session format.
 */
function nameEntry(name: string): string {
	return JSON.stringify({
		type: "custom",
		customType: "agent-identity-name",
		data: { name },
	});
}

function writeSession(dir: string, sub: string, file: string, lines: string[]): string {
	const full = join(dir, sub);
	mkdirSync(full, { recursive: true });
	const path = join(full, file);
	writeFileSync(path, lines.join("\n") + "\n");
	return path;
}

describe("findSessionByAgentName", () => {
	let sessionsDir: string;

	before(() => {
		sessionsDir = mkdtempSync(join(tmpdir(), "pi-sessions-"));
		// A couple of unrelated sessions
		writeSession(sessionsDir, "--repo-a--", "a.jsonl", [
			'{"type":"message"}',
			nameEntry("other-otter-1"),
		]);
		// The target agent lives here
		writeSession(sessionsDir, "--repo-b--", "b.jsonl", [
			'{"type":"message"}',
			'{"type":"custom","customType":"noise","data":{}}',
			nameEntry("shadow-lemur-3"),
		]);
	});

	after(() => {
		try { rmSync(sessionsDir, { recursive: true, force: true }); } catch {}
	});

	it("finds a session file by its embedded agent name", () => {
		const result = findSessionByAgentName("shadow-lemur-3", sessionsDir);
		assert.equal(result, join(sessionsDir, "--repo-b--", "b.jsonl"));
	});

	it("returns null when no session carries that name", () => {
		const result = findSessionByAgentName("ghost-who-never-was-0", sessionsDir);
		assert.equal(result, null);
	});

	it("returns null for an empty agent name", () => {
		const result = findSessionByAgentName("", sessionsDir);
		assert.equal(result, null);
	});

	it("returns null when the sessions dir does not exist", () => {
		const result = findSessionByAgentName("shadow-lemur-3", join(sessionsDir, "nope"));
		assert.equal(result, null);
	});

	it("returns the most recent session when a name was reused", () => {
		const older = writeSession(sessionsDir, "--repo-c--", "old.jsonl", [nameEntry("reused-raven-9")]);
		const newer = writeSession(sessionsDir, "--repo-c--", "new.jsonl", [nameEntry("reused-raven-9")]);
		// Force the intended ordering regardless of write speed.
		const past = new Date(Date.now() - 60_000);
		const now = new Date();
		utimesSync(older, past, past);
		utimesSync(newer, now, now);
		const result = findSessionByAgentName("reused-raven-9", sessionsDir);
		assert.equal(result, newer);
	});
});

describe("resolveTargetSession filesystem fallback", () => {
	let sessionsDir: string;

	before(async () => {
		await startMockDaemon();
		sessionsDir = mkdtempSync(join(tmpdir(), "pi-sessions-fb-"));
		writeSession(sessionsDir, "--repo-x--", "x.jsonl", [nameEntry("offline-owl-7")]);
	});

	after(async () => {
		await stopMockDaemon();
		try { rmSync(sessionsDir, { recursive: true, force: true }); } catch {}
	});

	it("falls back to the filesystem when the daemon has no record", async () => {
		// The mock daemon replies agent_not_found for this name.
		const result = await resolveTargetSession(
			"offline-owl-7", "polar-lemur-69", SOCKET_PATH, sessionsDir,
		);
		assert.equal(result, join(sessionsDir, "--repo-x--", "x.jsonl"));
	});

	it("returns null when neither daemon nor filesystem knows the agent", async () => {
		const result = await resolveTargetSession(
			"nowhere-newt-0", "polar-lemur-69", SOCKET_PATH, sessionsDir,
		);
		assert.equal(result, null);
	});
});
