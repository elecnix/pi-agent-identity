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
		// Rule 2 — PR descriptions must end with the agent name as a markdown
		// link to the extension that minted it, followed by the robot emoji.
		const signature = `— [${name}](${IDENTITY_EXTENSION_URL}) 🤖`;

		it("points the signature link at this extension", () => {
			// The whole point of the hyperlink is that a reader can find the
			// extension that minted the agent, so the URL must not drift to a
			// different repository.
			assert.equal(IDENTITY_EXTENSION_URL, "https://github.com/elecnix/pi-agent-identity");
		});

		it("instructs the agent to sign PR descriptions with a markdown link to this extension", () => {
			assert.ok(
				prompt.includes(signature),
				"PR description signature must hyperlink the agent name to the minting extension",
			);
		});

		it("instructs the agent to sign Linear comments the same way", () => {
			// Rule 3 — Linear tickets must use the same signature as PR descriptions.
			// The prompt has two signing rules; both must carry the hyperlink form.
			const occurrences = prompt.split(signature).length - 1;
			assert.ok(
				occurrences >= 2,
				`expected the hyperlink signature in both signing rules, found ${occurrences}`,
			);
		});

		it("does not offer an unlinked signature anywhere", () => {
			// The old plain-text signature must be gone, otherwise an agent may
			// still sign without the link.
			assert.equal(
				prompt.includes(`— ${name} 🤖`),
				false,
				"the prompt must not offer an unlinked signature variant",
			);
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