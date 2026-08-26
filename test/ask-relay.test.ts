/**
 * Tests for ask-over-daemon-relay semantics (#8).
 *
 * `ask` to a daemon-only agent fails hard with "Session not found" because
 * a ghost endpoint cannot hold a reply-waiter. The relay converts this into
 * an honest asynchronous flow: revive, deliver the questions, and tell the
 * sender the reply will arrive out-of-band instead of blocking.
 *
 * Run: node --experimental-strip-types --test test/ask-relay.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	buildRelayReport,
	buildAskRelayBody,
} from "../agent-identity/delivery-report.ts";

describe("buildRelayReport with ask semantics", () => {
	it("tells askers the reply will be asynchronous, not blocking", () => {
		const text = buildRelayReport("cosmic-shark-5", "revival", { wasAsk: true });
		assert.match(text, /cannot block/i);
		assert.match(text, /asynchronous|async/i);
		assert.match(text, /revived/i);
	});

	it("keeps plain revival wording without the ask flag", () => {
		const text = buildRelayReport("keen-gar-77", "revival");
		assert.doesNotMatch(text, /cannot block/);
	});

	it("live delivery of an ask is still direct delivery", () => {
		const text = buildRelayReport("sleepy-otter-3", "live", { wasAsk: true });
		assert.match(text, /online/);
	});
});

describe("buildAskRelayBody", () => {
	it("frames the relayed message as an ask that expects answers back", () => {
		const body = buildAskRelayBody("lucid-tiger-82", "What's the ETA on the stack merge?");
		assert.match(body, /lucid-tiger-82/);
		assert.match(body, /ask(ed)? while you were offline/i);
		assert.match(body, /What's the ETA on the stack merge\?/);
		assert.match(body, /intercom\(\{ action: "(send|ask)"/);
	});
});
