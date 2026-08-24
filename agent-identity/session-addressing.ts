/**
 * Tolerant agent-name resolution across composite session names.
 *
 * A live pi session may rename itself to the composite `<agent>: <task>`
 * form via `session_rename`, while peers still address it by the bare
 * agent name (`@agentname` is the documented addressing form). Exact-name
 * lookups then miss — a name-resolution failure, not an offline peer.
 *
 * Shared by the daemon (registry lookup) and the extension (roster
 * checks) so both resolve addresses the same way.
 */

export interface AddressableEntry {
	name: string;
}

/**
 * Resolve `target` against `entries`.
 *
 * 1. An exact `name` match always wins.
 * 2. Otherwise, fall back to entries whose name is the composite form
 *    `${target}: <suffix>`. If several qualify, the lexicographically
 *    smallest wins so the result is deterministic.
 *
 * Returns null when nothing matches (or inputs are empty). The returned
 * value is one of the given entries.
 */
export function resolveAgentAddress<T extends AddressableEntry>(
	target: string,
	entries: readonly T[],
): T | null {
	if (!target || entries.length === 0) return null;

	for (const entry of entries) {
		if (entry.name === target) return entry;
	}

	const prefix = `${target}: `;
	let best: T | null = null;
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix)) continue;
		if (!best || entry.name < best.name) best = entry;
	}
	return best;
}
