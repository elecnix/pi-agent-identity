/**
 * Tests for collision-free agent-name minting (#34).
 *
 * A session that mints a name already present in the daemon roster can
 * silently swallow messages meant for the previous holder (ghost mailbox
 * vs live session). The mint must therefore consult the roster and
 * re-roll on collision.
 *
 * Run: node --experimental-strip-types --test test/name-minting.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	parseAgentListResponse,
	pickFreshAgentName,
} from "../agent-identity/name-minting.ts";

describe("pickFreshAgentName", () => {
	it("returns an unused name untouched", () => {
		let calls = 0;
		const name = pickFreshAgentName(() => {
			calls++;
			return "swift-koala-42";
		}, new Set(["other-1", "other-2"]));
		assert.equal(name, "swift-koala-42");
		assert.equal(calls, 1);
	});

	it("re-rolls when the minted name is already taken", () => {
		const draws = ["taken-1", "taken-1", "fresh-7"];
		let i = 0;
		const name = pickFreshAgentName(() => draws[i++]!, new Set(["taken-1"]));
		assert.equal(name, "fresh-7");
	});

	it("keeps re-rolling through a long collision run", () => {
		let i = 0;
		const name = pickFreshAgentName(() => `n-${i++}`, new Set(["n-0", "n-1", "n-2"]));
		assert.equal(name, "n-3");
	});

	it("gives up after maxAttempts and returns the last draw (best effort)", () => {
		const name = pickFreshAgentName(() => "always-taken", new Set(["always-taken"]), 5);
		assert.equal(name, "always-taken");
	});
});

describe("parseAgentListResponse", () => {
	it("extracts names from an agent_list message", () => {
		const agents = parseAgentListResponse({
			type: "agent_list",
			agents: [
				{ name: "cosmic-shark-5", connected: true, repo: "a/b" },
				{ name: "keen-gar-77", connected: false },
			],
		});
		assert.deepEqual(agents, [
			{ name: "cosmic-shark-5", connected: true },
			{ name: "keen-gar-77", connected: false },
		]);
	});

	it("ignores malformed entries and wrong message types", () => {
		assert.deepEqual(parseAgentListResponse({ type: "pong" }), []);
		assert.deepEqual(parseAgentListResponse({ type: "agent_list", agents: "nope" }), []);
		assert.deepEqual(
			parseAgentListResponse({ type: "agent_list", agents: [{ nope: true }, null, { name: 5 }] }),
			[],
		);
	});
});
