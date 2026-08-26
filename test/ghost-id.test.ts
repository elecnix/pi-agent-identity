/**
 * Tests for stable ghost session IDs (#7).
 *
 * Daemon ghost registrations historically got a random broker-assigned
 * session ID, so offline ("revivable") agents could not be targeted with
 * `intercom({ to: "<session-id>" })`. Ghosts now register under a
 * deterministic ID derived from the agent name.
 *
 * Run: node --experimental-strip-types --test test/ghost-id.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ghostSessionIdFor } from "../agent-identity/ghost-id.ts";

describe("ghostSessionIdFor", () => {
	it("derives a deterministic id from the agent name", () => {
		assert.equal(ghostSessionIdFor("cosmic-shark-5"), "agent-cosmic-shark-5");
		assert.equal(ghostSessionIdFor("cosmic-shark-5"), "agent-cosmic-shark-5");
	});

	it("is non-empty and prefixed for every name (broker accepts any non-empty string)", () => {
		for (const name of ["keen-gar-77", "", "x"]) {
			const id = ghostSessionIdFor(name);
			assert.equal(typeof id, "string");
			assert.ok(id.length > 0);
			assert.ok(id.startsWith("agent-"));
		}
	});
});
