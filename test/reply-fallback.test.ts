/**
 * Tests for the reply-relay fallback (#6).
 *
 * A `reply` sent right after receiving a message can fail with
 * "Session not found" when the original sender's session was cleaned up
 * between send and reply. The relay hook must then derive the target and
 * route the reply through the daemon so the offline sender still gets it.
 *
 * Run: node --experimental-strip-types --test test/reply-fallback.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	extractFailedReplyTarget,
	buildReplyRelayBody,
} from "../agent-identity/reply-fallback.ts";

describe("extractFailedReplyTarget", () => {
	it("extracts the target from pi-intercom's failed-reply text", () => {
		const text =
			'Reply to "cosmic-shark-5" was not delivered: Session not found';
		assert.equal(extractFailedReplyTarget(text), "cosmic-shark-5");
	});

	it("extracts targets whose name contains quotes' neighbours cleanly", () => {
		const text = 'Reply to "keen-gar-77: fix-auth-bug" was not delivered: boom';
		assert.equal(extractFailedReplyTarget(text), "keen-gar-77: fix-auth-bug");
	});

	it("returns null for unrelated text", () => {
		assert.equal(extractFailedReplyTarget("Reply sent to keen-gar-77"), null);
		assert.equal(extractFailedReplyTarget(""), null);
	});

	it("handles non-string input", () => {
		assert.equal(extractFailedReplyTarget(undefined), null);
	});
});

describe("buildReplyRelayBody", () => {
	it("marks the relayed message as an asynchronous reply to the original thread", () => {
		const body = buildReplyRelayBody("lucid-tiger-82", "here is your answer");
		assert.match(body, /lucid-tiger-82/);
		assert.match(body, /asynchronous reply/i);
		assert.match(body, /here is your answer/);
		assert.match(body, /intercom\(\{ action: "reply"/);
	});
});
