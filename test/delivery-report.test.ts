/**
 * Tests for honest relay reporting on intercom delivery failures.
 *
 * Run: node --experimental-strip-types --test test/delivery-report.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	buildRelayReport,
	isNameResolutionMiss,
} from "../agent-identity/delivery-report.ts";

describe("isNameResolutionMiss", () => {
	it("detects the broker's 'Session not found' reason", () => {
		assert.equal(
			isNameResolutionMiss({ delivered: false, reason: "Session not found" }),
			true,
		);
	});

	it("is case-insensitive on the reason", () => {
		assert.equal(
			isNameResolutionMiss({ delivered: false, reason: "session not found" }),
			true,
		);
	});

	it("detects the E_TARGET_NOT_FOUND code even without a reason", () => {
		assert.equal(
			isNameResolutionMiss({ delivered: false, code: "E_TARGET_NOT_FOUND" }),
			true,
		);
	});

	it("does not classify other failures as name-resolution misses", () => {
		assert.equal(
			isNameResolutionMiss({ delivered: false, reason: "socket closed" }),
			false,
		);
		assert.equal(isNameResolutionMiss({ delivered: false }), false);
		assert.equal(isNameResolutionMiss({}), false);
	});
});

describe("buildRelayReport", () => {
	it("reports live delivery without claiming the target was offline", () => {
		const text = buildRelayReport("cosmic-shark-5", "live");
		assert.match(text, /online/);
		assert.match(text, /cosmic-shark-5/);
		assert.doesNotMatch(text, /is offline/i);
		assert.doesNotMatch(text, /revive/i);
	});

	it("claims revival only for the revival outcome", () => {
		const text = buildRelayReport("keen-gar-77", "revival");
		assert.match(text, /offline/);
		assert.match(text, /revived/i);
	});

	it("does not promise a revival when nothing was relayed (unresolved)", () => {
		const text = buildRelayReport("ghost-1", "unresolved");
		assert.doesNotMatch(text, /revive/i);
		assert.match(text, /could not deliver/i);
	});

	it("explains why no revival was attempted when deferred", () => {
		const text = buildRelayReport("sleepy-otter-3", "deferred");
		assert.doesNotMatch(text, /will be revived/i);
		assert.match(text, /NOT relayed/i);
		assert.match(text, /two writers/i);
	});
});
