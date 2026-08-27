/**
 * Tests for the agent_search tool's ranking/filtering logic.
 *
 * Lets an agent address a peer knowing only a short name fragment,
 * instead of listing hundreds of intercom sessions.
 *
 * Run: node --experimental-strip-types --test test/agent-search.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	formatAgentMatches,
	searchAgents,
	type AgentSearchEntry,
} from "../agent-identity/agent-search.ts";

const entries: AgentSearchEntry[] = [
	{ name: "cosmic-shark-5", rosterName: "cosmic-shark-5: test-harness-launcher-staging", connected: true },
	{ name: "keen-gar-77", connected: false },
	{ name: "sleepy-otter-3", rosterName: "sleepy-otter-3: fix-auth-bug", connected: true },
];

describe("searchAgents", () => {
	it("finds an exact bare-name match first", () => {
		const hits = searchAgents("keen-gar-77", entries);
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.name, "keen-gar-77");
	});

	it("matches case-insensitively", () => {
		assert.equal(searchAgents("KEEN-GAR-77", entries)[0]!.name, "keen-gar-77");
	});

	it("finds prefix matches on the bare name", () => {
		const hits = searchAgents("cosmic", entries);
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.rosterName, "cosmic-shark-5: test-harness-launcher-staging");
	});

	it("finds a hidden (offline) agent by its stable ghost id", () => {
		// Ghosts are hidden from the intercom roster — the id is the only
		// other handle a sender has besides the bare name.
		const pool: AgentSearchEntry[] = [
			{ name: "storm-skua-52", connected: false, ghostSessionId: "agent-storm-skua-52" },
		];
		const exact = searchAgents("agent-storm-skua-52", pool);
		assert.equal(exact.length, 1);
		assert.equal(exact[0]!.name, "storm-skua-52");

		const prefix = searchAgents("agent-storm", pool);
		assert.equal(prefix.length, 1);
		assert.equal(prefix[0]!.name, "storm-skua-52");
	});

	it("ranks exact matches above prefix matches", () => {
	 const pool: AgentSearchEntry[] = [
			{ name: "lucid-tiger-82", connected: true },
			{ name: "lucid-tiger-8", connected: true },
		];
		const hits = searchAgents("lucid-tiger-8", pool);
		assert.equal(hits[0]!.name, "lucid-tiger-8");
	});

	it("does not match substrings that are not prefixes", () => {
		assert.deepEqual(searchAgents("shark-5", entries), []);
	});

	it("returns [] for empty queries", () => {
		assert.deepEqual(searchAgents("   ", entries), []);
	});

	it("respects the limit after ranking", () => {
		const pool: AgentSearchEntry[] = [
			{ name: "aa-1" }, { name: "aa-2" }, { name: "aa-3" }, { name: "aa-4" },
		];
		assert.equal(searchAgents("aa", pool, 2).length, 2);
	});
});

describe("formatAgentMatches", () => {
	it("formats hits with roster names and status", () => {
		const text = formatAgentMatches("cosmic", searchAgents("cosmic", entries));
		assert.match(text, /cosmic-shark-5/);
		assert.match(text, /test-harness-launcher-staging/);
		assert.match(text, /online|connected/i);
	});

	it("exposes the stable ghost session id for offline targeting (#7)", () => {
		const pool: AgentSearchEntry[] = [
			{ name: "keen-gar-77", connected: false, ghostSessionId: "agent-keen-gar-77" },
		];
		const text = formatAgentMatches("keen", searchAgents("keen", pool));
		assert.match(text, /to: "agent-keen-gar-77"/);
	});

	it("mentions offline state for revivable agents", () => {
		const text = formatAgentMatches("keen", searchAgents("keen", entries));
		assert.match(text, /offline|revivable|disconnected/i);
	});

	it("states plainly when nothing matched", () => {
		const text = formatAgentMatches("ghost-99", []);
		assert.match(text, /no (?:matching )?agents?/i);
	});
});
