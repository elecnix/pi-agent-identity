/**
 * Session-name composition for the session_rename tool.
 *
 * Extracted from index.ts so the pure string logic is unit-testable without
 * a live pi session.
 */

/** The description the LLM sees for the `session_rename` tool. */
export const SESSION_RENAME_TOOL_DESCRIPTION = `Rename the current pi coding-agent session so it reflects the task at hand.

Call this tool AS SOON AS the first user message conveys the user's intent — i.e. immediately after reading the initial ask, before doing any substantive work. The session name should be short, kebab-case, and summarize the task, ticket number (if any), repository, and feature name. Renaming early keeps the session identifiable in the cmux/intercom roster while work is ongoing.

The agent's own name (e.g. \`keen-gar-77\`) is always kept as the prefix of the session name, separated by \`: \`. Provide the descriptive part only (e.g. \`fix-auth-bug\`); the tool composes the full name as \`<agent-name>: <description>\`. If the provided name already starts with the agent-name prefix it is not double-prefixed.`;

/**
 * Compose a session name that keeps the agent name as a prefix.
 *
 * - `keen-gar-77` + `"fix auth bug"` → `keen-gar-77: fix auth bug`
 * - `keen-gar-77` + `"keen-gar-77: fix auth bug"` → `keen-gar-77: fix auth bug` (idempotent)
 * - `keen-gar-77` + `""` → `keen-gar-77` (no description, keep bare name)
 * - `""` + `"fix auth bug"` → `fix auth bug` (no agent name yet, don't emit `: `)
 *
 * The provided name is trimmed. When the trimmed value already starts with
 * `<agentName>: ` the prefix is not repeated.
 */
export function composeSessionName(agentName: string, providedName: string): string {
	const desc = providedName.trim();
	const prefix = agentName.trim();

	if (!prefix) return desc;
	if (!desc) return prefix;

	const fullPrefix = `${prefix}: `;
	if (desc.startsWith(fullPrefix)) return desc;

	return `${fullPrefix}${desc}`;
}