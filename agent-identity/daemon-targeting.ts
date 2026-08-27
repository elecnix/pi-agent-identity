/**
 * Daemon-side target resolution, ghost-id aware.
 *
 * Ghosted (disconnected-but-revivable) agents are hidden from the intercom
 * roster list, but stay addressable by name or by their stable ghost id
 * (`agent-<name>`, see ghost-id.ts). agent_search advertises both forms;
 * the daemon's queue_mention resolves either so a message to a hidden
 * ghost triggers session revival.
 */

import { resolveAgentAddress, type AddressableEntry } from "./session-addressing.ts";
import { ghostSessionIdFor } from "./ghost-id.ts";

/**
 * Resolve `target` against registry `entries`:
 *
 * 1. Exact bare-name match, then composite `<name>: <suffix>` match
 *    (via resolveAgentAddress — the documented addressing forms).
 * 2. Otherwise, the stable ghost id `agent-<name>` form, so senders who
 *    targeted a ghost's advertised `to: "<ghost-session-id>"` still
 *    reach the agent even though the ghost is not in the broker roster.
 *
 * Returns the matching entry or null.
 */
export function resolveDaemonTarget<T extends AddressableEntry>(
	target: string,
	entries: readonly T[],
): T | null {
	const byName = resolveAgentAddress(target, entries);
	if (byName) return byName;

	for (const entry of entries) {
		if (target === ghostSessionIdFor(entry.name)) return entry;
	}
	return null;
}

/**
 * Adapt daemon registry entries for address resolution.
 *
 * The daemon registry keys agents by `agentName`, while resolveAgentAddress
 * and resolveDaemonTarget read `name`. Passing raw registrations made every
 * daemon-side lookup miss (resolution saw `undefined` for every name).
 */
export function toAddressable<T extends { agentName: string }>(
	registrations: readonly T[],
): Array<T & AddressableEntry> {
	return registrations.map((reg) => ({ ...reg, name: reg.agentName }));
}