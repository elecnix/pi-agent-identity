/**
 * Stable ghost session IDs (#7).
 *
 * The daemon's ghost intercom registrations (for disconnected-but-revivable
 * agents) previously received a random broker-assigned session ID, which
 * meant offline agents had no addressable `to: "<session-id>"` form. Ghosts
 * now register under a deterministic ID derived from the agent name, so the
 * same agent always presents the same ID whenever it is offline.
 */

/** Deterministic broker sessionId for a ghost-registered agent. */
export function ghostSessionIdFor(agentName: string): string {
	return `agent-${agentName}`;
}
