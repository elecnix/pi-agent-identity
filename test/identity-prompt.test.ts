/**
 * Tests for the agent-identity system prompt fragment.
 *
 * Tests the ACTUAL production code, not a replica.
 *
 * Run: node --experimental-strip-types --test test/identity-prompt.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildIdentityPrompt } from "../agent-identity/identity-prompt.ts";

describe("buildIdentityPrompt", () => {
	const name = "steady-panda-28";
	const prompt = buildIdentityPrompt(name);

	it("includes the agent name in the identity header", () => {
		assert.match(prompt, /YOUR AGENT NAME: steady-panda-28/);
	});

	it("opens an <agent_identity> block", () => {
		assert.match(prompt, /<agent_identity>/);
	});

	describe("signing with a robot emoji", () => {
		it("instructs the agent to append a robot emoji when signing PR descriptions", () => {
			// Rule 2 — PR descriptions must end with `— <name> 🤖`.
			assert.match(
				prompt,
				/— steady-panda-28 🤖/,
				"PR description signature must include the robot emoji",
			);
		});

		it("instructs the agent to append a robot emoji when signing Linear comments", () => {
			// Rule 3 — Linear tickets must end with `— <name> 🤖`.
			// The prompt has two signing rules; both must carry the emoji.
			const matches = prompt.match(/— steady-panda-28 🤖/g);
			assert.ok(
				matches && matches.length >= 2,
				"both PR-description and Linear-ticket signing rules must use the emoji signature",
			);
		});

		it("does not put a robot emoji in the commit co-authorship trailer", () => {
			// Rule 1 — git Co-authored-by trailers are structured metadata;
			// an emoji there would corrupt the trailer. The trailer line
			// must stay clean.
			assert.match(prompt, /Co-authored-by: steady-panda-28 <steady-panda-28@pi-agent\.local>/);
			assert.doesNotMatch(
				prompt,
				/Co-authored-by:[^\n]*🤖/,
				"the co-authorship trailer must not carry the robot emoji",
			);
		});
	});

	it("keeps the agent name out of source code per the code-exclusion rule", () => {
		assert.match(prompt, /NEVER include your agent name "steady-panda-28"/);
	});
});