/**
 * Stable ghost session IDs (#7).
 *
 * Disconnected-but-revivable agents are hidden from the intercom roster
 * list — the daemon no longer registers them with the broker. They stay
 * addressable while offline under a deterministic ID derived from the
 * agent name, so the same agent always presents the same offline id.
 * The daemon resolves this id in queue_mention/lookup_agent, so a sender
 * who found the agent via agent_search can message it and trigger revival.
 */

/** Deterministic id for targeting a ghosted (offline, revivable) agent. */
export function ghostSessionIdFor(agentName: string): string {
	return `agent-${agentName}`;
}
