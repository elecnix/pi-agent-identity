/**
 * Tests for session-name composition + the session_rename tool description.
 *
 * Tests the ACTUAL production code, not a replica.
 *
 * Run: node --experimental-strip-types --test test/session-name.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	composeSessionName,
	SESSION_RENAME_TOOL_DESCRIPTION,
} from "../agent-identity/session-name.ts";

// ─── composeSessionName ──────────────────────────────────────────────────────

describe("composeSessionName", () => {
	it("prefixes the agent name before the provided name", () => {
		assert.equal(
			composeSessionName("keen-gar-77", "fix auth bug"),
			"keen-gar-77: fix auth bug",
		);
	});

	it("trims surrounding whitespace from the provided name", () => {
		assert.equal(
			composeSessionName("keen-gar-77", "   fix auth bug   "),
			"keen-gar-77: fix auth bug",
		);
	});

	it("is idempotent — does not stack the prefix if already prefixed", () => {
		assert.equal(
			composeSessionName("keen-gar-77", "keen-gar-77: fix auth bug"),
			"keen-gar-77: fix auth bug",
		);
	});

	it("collapses to the bare agent name when the provided name is empty", () => {
		assert.equal(composeSessionName("keen-gar-77", ""), "keen-gar-77");
	});

	it("collapses to the bare agent name when the provided name is whitespace only", () => {
		assert.equal(composeSessionName("keen-gar-77", "   "), "keen-gar-77");
	});

	it("returns the provided name unchanged when agentName is empty (guard)", () => {
		// Tool may be called before session_start assigned a name — don't
		// produce a leading ": ".
		assert.equal(composeSessionName("", "fix auth bug"), "fix auth bug");
	});

	it("handles a provided name that contains the agent name as a substring but not a prefix", () => {
		// "keen-gar-77-fix" does not start with "keen-gar-77: " so it should
		// get the prefix.
		assert.equal(
			composeSessionName("keen-gar-77", "keen-gar-77-fix auth"),
			"keen-gar-77: keen-gar-77-fix auth",
		);
	});
});

// ─── session_rename tool description contract ────────────────────────────────

describe("session_rename tool description", () => {
	it("instructs the agent to rename ASAP on the first user message with intent", () => {
		const d = SESSION_RENAME_TOOL_DESCRIPTION;
		assert.match(d, /rename/i, "must mention 'rename'");
		assert.match(d, /as soon as/i, "must say 'as soon as'");
		// "first" user message with intent — cover either phrasing.
		assert.ok(/first/i.test(d) || /earliest/i.test(d), "must reference the first/earliest message");
		assert.match(d, /intent/i, "must reference the user's intent");
	});

	it("instructs that the agent name stays the prefix of the session name", () => {
		assert.match(
			SESSION_RENAME_TOOL_DESCRIPTION,
			/prefix/i,
			"must mention the agent-name prefix",
		);
	});
});