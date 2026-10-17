/**
 * Tests for the agent-identity system prompt fragment.
 *
 * Tests the ACTUAL production code, not a replica.
 *
 * Run: node --experimental-strip-types --test test/identity-prompt.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildIdentityPrompt, IDENTITY_EXTENSION_URL } from "../agent-identity/identity-prompt.ts";

describe("buildIdentityPrompt", () => {
	const name = "steady-panda-28";
	const prompt = buildIdentityPrompt(name);

	it("includes the agent name in the identity header", () => {
		assert.match(prompt, /YOUR AGENT NAME: steady-panda-28/);
	});

	it("opens an <agent_identity> block", () => {
		assert.match(prompt, /<agent_identity>/);
	});

	describe("signing with hyperlink markdown and a robot emoji", () => {
		// Rules 2 (PR descriptions) and 3 (Linear tickets) must each end with the
		// agent name as a markdown link to the extension that minted it,
		// followed by the robot emoji.
		const signature = `— [${name}](${IDENTITY_EXTENSION_URL}) 🤖`;
		const plain = `— ${name} 🤖`;

		/**
		 * Text of the numbered identity rule whose bold title matches, including
		 * its continuation lines. Asserting per rule is what makes each signing
		 * rule independently covered: a whole-prompt count would still pass if one
		 * rule carried the signature twice and the other carried the plain form.
		 */
		const ruleBody = (title: string): string => {
			const block = prompt
				.split(/\n(?=\d+\. \*\*)/)
				.find((b) => b.includes(`**${title}**`));
			if (!block) throw new Error(`identity rule "${title}" must exist in the prompt`);
			return block;
		};

		it("points the signature link at this extension", () => {
			// The whole point of the hyperlink is that a reader can find the
			// extension that minted the agent, so the URL must not drift to a
			// different repository.
			assert.equal(IDENTITY_EXTENSION_URL, "https://github.com/elecnix/pi-agent-identity");
		});

		it("signs PR descriptions with the hyperlink signature", () => {
			assert.ok(
				ruleBody("PR descriptions").includes(signature),
				"the PR-description rule must hyperlink the agent name to the minting extension",
			);
		});

		it("signs Linear comments with the hyperlink signature", () => {
			assert.ok(
				ruleBody("Linear tickets").includes(signature),
				"the Linear-ticket rule must hyperlink the agent name to the minting extension",
			);
		});

		it("offers no unlinked signature in either signing rule", () => {
			// The plain-text signature must be gone, otherwise an agent may still
			// sign without the link.
			for (const title of ["PR descriptions", "Linear tickets"]) {
				assert.equal(
					ruleBody(title).includes(plain),
					false,
					`the ${title} rule must not offer an unlinked signature`,
				);
			}
			assert.equal(prompt.includes(plain), false, "the prompt must not offer an unlinked signature");
		});

		it("does not put a robot emoji or a link in the commit co-authorship trailer", () => {
			// Rule 1 — git Co-authored-by trailers are structured metadata;
			// an emoji or markdown there would corrupt the trailer. The trailer
			// line must stay clean.
			assert.match(prompt, /Co-authored-by: steady-panda-28 <steady-panda-28@pi-agent\.local>/);
			assert.doesNotMatch(
				prompt,
				/Co-authored-by:[^\n]*🤖/,
				"the co-authorship trailer must not carry the robot emoji",
			);
			assert.doesNotMatch(
				prompt,
				/Co-authored-by:[^\n]*\[/,
				"the co-authorship trailer must not carry markdown link syntax",
			);
		});
	});

	it("keeps the agent name out of source code per the code-exclusion rule", () => {
		assert.match(prompt, /NEVER include your agent name "steady-panda-28"/);
	});
});