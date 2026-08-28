/**
 * PI_AGENT_NAME environment exposure for LLM bash subprocesses.
 *
 * The identity is set once at session start on the pi process itself; pi
 * builds the bash tool's child environment per execution spreading
 * process.env, so the var reaches every bash tool command by inheritance
 * — no command rewriting involved.
 */

/** Apply the identity to the environment pi will pass to bash children. */
export function applyAgentNameEnv(env: Record<string, string | undefined>, name: string): void {
	if (name) {
		env["PI_AGENT_NAME"] = name;
	}
}