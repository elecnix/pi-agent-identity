/**
 * Tests for fork identity disambiguation (#43).
 *
 * When a pi session forks a background subtask, the child session file is
 * created by copying the parent's entries verbatim — including the
 * `agent-identity-name` custom entry — and records `parentSession` in its
 * header. The child therefore restores the parent's agent name and both
 * sessions come up live at the same time under the same name, which breaks
 * intercom addressing, commit attribution, and roster readability.
 *
 * The child must be re-identified with a deterministic suffix derived from
 * its own session id (already unique per session), so the same fork always
 * presents the same name across daemon restarts and session reloads.
 *
 * Run: node --experimental-strip-types --test test/fork-identity.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	forkSuffixFor,
	isForkedSession,
	composeForkIdentity,
	maybeSuffixForkIdentity,
} from "../agent-identity/fork-identity.ts";

const SID = "019ff42f-20c5-7273-92c0-c66816ffe58b";
const OTHER_SID = "01a04066-b944-7bc2-a987-6bb18470bbef";

describe("forkSuffixFor", () => {
	it("derives a short deterministic hash from the session id", () => {
		const a = forkSuffixFor(SID);
		const b = forkSuffixFor(SID);
		assert.equal(a, b);
		assert.match(a, /^[0-9a-f]{8}$/);
	});

	it("differs for different session ids", () => {
		assert.notEqual(forkSuffixFor(SID), forkSuffixFor(OTHER_SID));
	});
});

describe("isForkedSession", () => {
	it("is true when the header carries a parentSession", () => {
		assert.equal(isForkedSession({ parentSession: "/path/to/parent.jsonl" }), true);
	});

	it("is false for a fresh session header", () => {
		assert.equal(isForkedSession({}), false);
		assert.equal(isForkedSession(null), false);
		assert.equal(isForkedSession(undefined), false);
	});

	it("is false when parentSession is empty or not a string", () => {
		assert.equal(isForkedSession({ parentSession: "" }), false);
		assert.equal(
			isForkedSession({ parentSession: 42 } as unknown as { parentSession?: string }),
			false,
		);
	});
});

describe("composeForkIdentity", () => {
	it("appends the session-id suffix to the parent name", () => {
		const name = composeForkIdentity("swift-koala-42", SID);
		assert.equal(name, `swift-koala-42-${forkSuffixFor(SID)}`);
	});
});

describe("maybeSuffixForkIdentity", () => {
	const forkHeader = { parentSession: "/p.jsonl" };

	it("suffixes a restored bare name on a forked session", () => {
		const out = maybeSuffixForkIdentity("swift-koala-42", forkHeader, SID);
		assert.equal(out, `swift-koala-42-${forkSuffixFor(SID)}`);
	});

	it("leaves a fresh (non-forked) session name untouched", () => {
		assert.equal(maybeSuffixForkIdentity("swift-koala-42", {}, SID), "swift-koala-42");
		assert.equal(maybeSuffixForkIdentity("swift-koala-42", null, SID), "swift-koala-42");
	});

	it("is idempotent — does not double-suffix an already suffixed name", () => {
		const once = maybeSuffixForkIdentity("swift-koala-42", forkHeader, SID);
		const twice = maybeSuffixForkIdentity(once, forkHeader, SID);
		assert.equal(twice, once);
	});

	it("leaves an empty name untouched", () => {
		assert.equal(maybeSuffixForkIdentity("", forkHeader, SID), "");
	});
});
