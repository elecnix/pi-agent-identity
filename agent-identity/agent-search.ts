/**
 * agent_search — address a peer knowing only a short name fragment.
 *
 * Listing the full intercom roster dumps hundreds of entries into a
 * transcript just to find one peer. This module ranks candidate agents
 * against a short query (exact bare name first, then prefix) and formats
 * a compact result so the sender can pick an address in one cheap step.
 */

export interface AgentSearchEntry {
	/** Immutable bare agent name (daemon registry key). */
	name: string;
	/** Full registered intercom name, when known (`<agent>: <task>`). */
	rosterName?: string;
	/** Live/connected state, when known. */
	connected?: boolean;
	/** Stable broker id for offline targeting (`to: "<ghost-session-id>"`). */
	ghostSessionId?: string;
}

interface RankedHit extends AgentSearchEntry {
	rank: number;
}

/**
 * Filter and rank `entries` against `query`:
 *   rank 0 — exact match on the bare name
 *   rank 1 — bare-name prefix match
 * Ties are broken by shorter name, then alphabetically. Returns at most
 * `limit` hits (default 10).
 */
export function searchAgents(
	query: string,
	entries: readonly AgentSearchEntry[],
	limit = 10,
): AgentSearchEntry[] {
	const wanted = query.trim().toLowerCase();
	if (!wanted) return [];

	const ranked: RankedHit[] = [];
	for (const entry of entries) {
		const name = entry.name.toLowerCase();
		let rank: number | null = null;
		if (name === wanted) rank = 0;
		else if (name.startsWith(wanted)) rank = 1;
		if (rank !== null) ranked.push({ ...entry, rank });
	}

	ranked.sort((a, b) =>
		a.rank - b.rank ||
		a.name.length - b.name.length ||
		a.name.localeCompare(b.name),
	);

	return ranked.slice(0, limit).map(({ rank: _rank, ...hit }) => hit);
}

/** Format hits as a compact, LLM-friendly listing. */
export function formatAgentMatches(query: string, hits: readonly AgentSearchEntry[]): string {
	if (hits.length === 0) {
		return `No matching agents for "${query.trim()}".`;
	}
	const lines = hits.map((hit) => {
		const status =
			hit.connected === undefined ? "" : hit.connected ? " (online)" : " (offline, revivable)";
		const full = hit.rosterName && hit.rosterName !== hit.name
			? ` — registered as "${hit.rosterName}"`
			: "";
		const ghost = !hit.connected && hit.ghostSessionId
			? ` — while offline, targetable with to: "${hit.ghostSessionId}"`
			: "";
		return `- ${hit.name}${full}${status}${ghost}`;
	});
	return `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query.trim()}":\n${lines.join("\n")}`;
}
