/**
 * Tests for tolerant agent-name resolution against composite session names.
 *
 * Run: node --experimental-strip-types --test test/session-addressing.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolveAgentAddress } from "../agent-identity/session-addressing.ts";

describe("resolveAgentAddress", () => {
	it("returns the exact match when one exists", () => {
		const entries = [
			{ name: "cosmic-shark-5" },
			{ name: "cosmic-shark-5: test-harness-launcher-staging" },
		];
		const hit = resolveAgentAddress("cosmic-shark-5", entries);
		assert.equal(hit, entries[0]);
	});

	it("falls back to a composite `<agent>: <suffix>` match", () => {
		const entries = [
			{ name: "keen-gar-77: fix-auth-bug" },
			{ name: "other-agent-1" },
		];
		const hit = resolveAgentAddress("keen-gar-77", entries);
		assert.equal(hit, entries[0]);
	});

	it("prefers the exact match over a composite match", () => {
		const composite = { name: "cosmic-shark-5: staging" };
		const bare = { name: "cosmic-shark-5" };
		assert.equal(resolveAgentAddress("cosmic-shark-5", [composite, bare]), bare);
	});

	it("picks the lexicographically smallest name among several composite matches", () => {
		const b = { name: "cosmic-shark-5: zeta-task" };
		const a = { name: "cosmic-shark-5: alpha-task" };
		assert.equal(resolveAgentAddress("cosmic-shark-5", [b, a]), a);
	});

	it("does not match a bare-name substring that is not the composite prefix form", () => {
		// "shark-5" is a substring of "cosmic-shark-5" but neither an exact
		// match nor a "<shark-5>: ..." composite — must not resolve.
		assert.equal(
			resolveAgentAddress("shark-5", [{ name: "cosmic-shark-5" }]),
			null,
		);
	});

	it("requires the ': ' separator for composite matches", () => {
		assert.equal(
			resolveAgentAddress("keen-gar-77", [{ name: "keen-gar-77fix auth" }]),
			null,
		);
	});

	it("returns null when nothing matches", () => {
		assert.equal(resolveAgentAddress("ghost-1", [{ name: "keen-gar-77" }]), null);
	});

	it("returns null for empty inputs", () => {
		assert.equal(resolveAgentAddress("", [{ name: "keen-gar-77" }]), null);
		assert.equal(resolveAgentAddress("keen-gar-77", []), null);
	});
});
