/**
 * Intercom addressing via the immutable agent identity.
 *
 * pi-intercom's live roster carries the mutable session display name
 * (`<agent>: <task>` after session_rename) and resolves `to` by exact
 * (case-insensitive) name or session-ID prefix. A peer addressing the
 * bare agent identity therefore misses. This module resolves a `to`
 * value against the live roster so the extension can rewrite it to the
 * registered name before the send reaches the broker.
 *
 * Run: node --experimental-strip-types --test test/intercom-addressing.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	resolveIntercomTarget,
	IDENTITY_CHANNEL_NAMESPACE,
	type RosterSession,
} from "../agent-identity/intercom-addressing.ts";

const sessions: RosterSession[] = [
	{ id: "aaaa-1111", name: "cosmic-shark-5: test-harness-launcher-staging" },
	{ id: "bbbb-2222", name: "keen-gar-77" },
	{ id: "cccc-3333", name: "sleepy-otter-3: fix-auth-bug" },
];

describe("resolveIntercomTarget", () => {
	it("announces the stable channel namespace for identity registration", () => {
		assert.equal(IDENTITY_CHANNEL_NAMESPACE, "agent-identity/v1");
	});

	it("resolves an exact roster name unchanged", () => {
		const r = resolveIntercomTarget("keen-gar-77", sessions);
		assert.equal(r.status, "exact");
		assert.equal(r.name, "keen-gar-77");
	});

	it("matches exact names case-insensitively", () => {
		const r = resolveIntercomTarget("KEEN-GAR-77", sessions);
		assert.equal(r.status, "exact");
		assert.equal(r.name, "keen-gar-77");
	});

	it("rewrites a bare agent identity to its composite registered name", () => {
		const r = resolveIntercomTarget("cosmic-shark-5", sessions);
		assert.equal(r.status, "rewritten");
		assert.equal(r.name, "cosmic-shark-5: test-harness-launcher-staging");
	});

	it("rewrites a bare agent identity case-insensitively", () => {
		const r = resolveIntercomTarget("COSMIC-SHARK-5", sessions);
		assert.equal(r.status, "rewritten");
		assert.equal(r.name, "cosmic-shark-5: test-harness-launcher-staging");
	});

	it("reports ambiguity when several composite names share the prefix", () => {
		const dupes: RosterSession[] = [
			{ id: "d1", name: "keen-gar-77: task-a" },
			{ id: "d2", name: "keen-gar-77: task-b" },
			{ id: "d3", name: "other-1" },
		];
		const r = resolveIntercomTarget("keen-gar-77", dupes);
		assert.equal(r.status, "ambiguous");
		assert.equal(r.name, null);
	});

	it("prefers an exact match over composite candidates", () => {
		const both: RosterSession[] = [
			{ id: "e1", name: "keen-gar-77: task-a" },
			{ id: "e2", name: "keen-gar-77" },
		];
		const r = resolveIntercomTarget("keen-gar-77", both);
		assert.equal(r.status, "exact");
		assert.equal(r.name, "keen-gar-77");
	});

	it("does not match a substring that is not the composite prefix form", () => {
		assert.equal(resolveIntercomTarget("shark-5", sessions)?.status, "not-found");
	});

	it("requires the ': ' separator for composite matches", () => {
		const noSep: RosterSession[] = [{ id: "n1", name: "keen-gar-77fix auth" }];
		assert.equal(resolveIntercomTarget("keen-gar-77", noSep)?.status, "not-found");
	});

	it("returns not-found when nothing matches (fall through to relay)", () => {
		assert.equal(resolveIntercomTarget("ghost-99", sessions)?.status, "not-found");
	});

	it("handles sessions with missing names and empty targets", () => {
		assert.equal(resolveIntercomTarget("", sessions)?.status, "not-found");
		assert.equal(
			resolveIntercomTarget("keen-gar-77", [{ id: "x1" }])?.status,
			"not-found",
		);
	});
});
