/**
 * Tests for the PR/issue @mention notification formatter.
 *
 * The notification injected into a session when its agent is @mentioned on a
 * GitHub PR or Linear ticket must read as **informational situation
 * awareness**: the receiver is told a mention happened, but no response is
 * expected unless the agent was explicitly asked a question or has
 * substantive new information to contribute.
 *
 * Run: node --experimental-strip-types --test test/mention-notification.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { formatMentionNotification } from "../agent-identity/mention-notification.ts";

describe("formatMentionNotification", () => {
	const base = {
		from: "rapid-gecko-48",
		agentName: "iron-panda-50",
		body: "Confirmed — the plan comment on PRI-1423 is revised.",
		url: "https://github.com/elecnix/pi-agent-identity/pull/12#issuecomment-123",
		prNumber: 12,
	};

	it("includes the sender, receiver, PR label, truncated body, and URL", () => {
		const out = formatMentionNotification(base);
		assert.match(out, /@rapid-gecko-48/);
		assert.match(out, /@iron-panda-50/);
		assert.match(out, /PR #12/);
		assert.match(out, /Confirmed — the plan comment on PRI-1423 is revised\./);
		assert.match(out, /https:\/\/github\.com\/elecnix\/pi-agent-identity\/pull\/12#issuecomment-123/);
	});

	it("labels a missing prNumber as a PR/issue rather than PR #0", () => {
		const out = formatMentionNotification({ ...base, prNumber: undefined });
		assert.match(out, /a PR\/issue/);
		assert.doesNotMatch(out, /PR #0/);
	});

	it("states the mention is informational and no response is expected", () => {
		const out = formatMentionNotification(base);
		assert.match(out, /informational/i);
		assert.match(out, /no response is expected/i);
	});

	it("does not instruct the receiver to respond naturally or reply unconditionally", () => {
		const out = formatMentionNotification(base);
		assert.doesNotMatch(out, /Respond to this mention naturally/i);
		assert.doesNotMatch(out, /reply to @/i);
	});

	it("narrows the reply condition to explicit questions or substantive new info", () => {
		const out = formatMentionNotification(base);
		assert.match(out, /explicitly asked/i);
		assert.match(out, /substantive/i);
	});

	it("truncates a very long body", () => {
		const long = "x".repeat(5000);
		const out = formatMentionNotification({ ...base, body: long });
		assert.ok(out.length < long.length + 2000, "body must be truncated");
		// The full 5000-char body must not survive into the notification.
		assert.doesNotMatch(out, /x{5000}/);
	});

	it("handles a missing url and unknown sender", () => {
		const out = formatMentionNotification({
			from: "",
			agentName: "iron-panda-50",
			body: "hi",
			url: "",
			prNumber: undefined,
		});
		assert.match(out, /@unknown/);
		assert.match(out, /informational/i);
		assert.match(out, /no response is expected/i);
	});
});