import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyAgentNameEnv } from "../agent-identity/env.ts";

describe("applyAgentNameEnv", () => {
	beforeEach(() => {
		delete process.env.PI_AGENT_NAME;
	});

	test("sets PI_AGENT_NAME on the process env for a minted identity", () => {
		applyAgentNameEnv(process.env, "keen-gar-77");
		assert.equal(process.env.PI_AGENT_NAME, "keen-gar-77");
	});

	test("is a no-op when no identity is assigned yet", () => {
		applyAgentNameEnv(process.env, "");
		assert.equal(process.env.PI_AGENT_NAME, undefined);
	});

	test("does not touch pi core session metadata vars", () => {
		const env: Record<string, string | undefined> = {
			PI_SESSION_ID: "s1",
			PI_PROVIDER: "anthropic",
			PI_MODEL: "claude-haiku-4-5",
			PI_REASONING_LEVEL: "high",
		};
		applyAgentNameEnv(env, "keen-gar-77");
		assert.equal(env["PI_SESSION_ID"], "s1");
		assert.equal(env["PI_PROVIDER"], "anthropic");
		assert.equal(env["PI_MODEL"], "claude-haiku-4-5");
		assert.equal(env["PI_REASONING_LEVEL"], "high");
		assert.equal(env["PI_AGENT_NAME"], "keen-gar-77");
	});
});