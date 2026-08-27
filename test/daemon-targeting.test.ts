/**
 * Tests for daemon-side target resolution with ghost-id support.
 *
 * Ghosted (disconnected-but-revivable) agents no longer register with the
 * intercom broker, so they vanish from the normal roster list. They stay
 * reachable through the daemon: agent_search surfaces them by name or by
 * their stable ghost id (`agent-<name>`), and the daemon's queue_mention
 * must resolve both forms so a message to a hidden ghost triggers revival.
 *
 * Run: node --experimental-strip-types --test test/daemon-targeting.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolveDaemonTarget, toAddressable } from "../agent-identity/daemon-targeting.ts";
import { ghostSessionIdFor } from "../agent-identity/ghost-id.ts";

const entries = [
	{ name: "storm-skua-52" },
	{ name: "keen-gar-77" },
	{ name: "storm-petrel-9" },
];

describe("resolveDaemonTarget", () => {
	it("resolves a bare agent name", () => {
		assert.equal(resolveDaemonTarget("keen-gar-77", entries)?.name, "keen-gar-77");
	});

	it("resolves the composite `<name>: <task>` form", () => {
		// Registry where the agent's only entry carries the renamed composite.
		const withRename = [{ name: "storm-skua-52: fix-auth-bug" }, { name: "keen-gar-77" }];
		assert.equal(
			resolveDaemonTarget("storm-skua-52", withRename)?.name,
			"storm-skua-52: fix-auth-bug",
		);
	});

	it("resolves the stable ghost session id of an offline agent", () => {
		const id = ghostSessionIdFor("storm-skua-52");
		assert.equal(id, "agent-storm-skua-52");
		assert.equal(resolveDaemonTarget(id, entries)?.name, "storm-skua-52");
	});

	it("returns null for unknown targets", () => {
		assert.equal(resolveDaemonTarget("nobody-here-1", entries), null);
	});

	it("returns null for empty input", () => {
		assert.equal(resolveDaemonTarget("", entries), null);
		assert.equal(resolveDaemonTarget("storm-skua-52", []), null);
	});
});

describe("toAddressable", () => {
	// The daemon registry stores `agentName`; resolution reads `name`.
	// Passing raw registrations made every daemon-side lookup miss.
	it("exposes the registration's agentName as the addressable name", () => {
		const regs = [{ agentName: "storm-skua-52", pid: 123 }];
		const addressable = toAddressable(regs);
		assert.equal(addressable[0]!.name, "storm-skua-52");
		assert.equal(resolveDaemonTarget("storm-skua-52", addressable)?.name, "storm-skua-52");
		assert.equal(
			resolveDaemonTarget(ghostSessionIdFor("storm-skua-52"), addressable)?.name,
			"storm-skua-52",
		);
	});

	it("keeps the rest of the registration intact", () => {
		const regs = [{ agentName: "keen-gar-77", pid: 7, sessionFile: "/tmp/s.jsonl" }];
		const addressable = toAddressable(regs);
		assert.equal((addressable[0] as Record<string, unknown>)["pid"], 7);
		assert.equal((addressable[0] as Record<string, unknown>)["sessionFile"], "/tmp/s.jsonl");
	});
});