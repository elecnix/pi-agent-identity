/**
 * Collision-free agent-name minting (#34).
 *
 * `generateName()` draws from a finite pool (40 × 40 × 100). A fresh mint
 * that lands on a name still registered in the daemon roster (e.g. a
 * disconnected-but-revivable agent with a ghost intercom session) makes the
 * broker route messages for that name into the ghost's mailbox instead of
 * to this live session — silently. The mint therefore consults the daemon
 * roster and re-rolls on collision.
 */

export interface FreshNameMinter {
	(): string;
}

/**
 * Draw names via `mint` until one is not in `taken`, up to `maxAttempts`
 * draws (default 10 — the collision odds make more pointless). Returns the
 * last draw even if still colliding: a live collision is better than not
 * starting, and later registration replaces stale entries.
 */
export function pickFreshAgentName(
	mint: FreshNameMinter,
	taken: ReadonlySet<string>,
	maxAttempts = 10,
): string {
	let name = mint();
	for (let attempt = 1; attempt < maxAttempts && taken.has(name); attempt++) {
		name = mint();
	}
	return name;
}

/** The daemon's `agent_list` reply shape. */
export interface DaemonAgentListReply {
	type?: string;
	agents?: unknown;
}

/**
 * Parse an `agent_list` response into `{ name, connected }` pairs,
 * ignoring malformed entries and non-agent_list messages.
 */
export interface DaemonAgentSummary {
	name: string;
	connected: boolean;
	/** Stable broker id the agent presents while offline (#7). */
	ghostSessionId?: string;
}

export function parseAgentListResponse(msg: DaemonAgentListReply): DaemonAgentSummary[] {
	if (!msg || msg.type !== "agent_list" || !Array.isArray(msg.agents)) return [];
	const out: DaemonAgentSummary[] = [];
	for (const entry of msg.agents) {
		const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
		if (!rec || typeof rec.name !== "string" || rec.name.length === 0) continue;
		out.push({
			name: rec.name,
			connected: Boolean(rec.connected),
			...(typeof rec.ghostSessionId === "string" && rec.ghostSessionId.length > 0
				? { ghostSessionId: rec.ghostSessionId }
				: {}),
		});
	}
	return out;
}
