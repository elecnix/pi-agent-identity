/**
 * Intercom addressing via the immutable agent identity.
 *
 * The agent identity (e.g. `cosmic-shark-5`) is the addressable subject;
 * the session name is mutable display metadata. pi-intercom registers live
 * sessions under `pi.getSessionName()` and resolves `to` by exact
 * case-insensitive name or session-ID prefix, so after `session_rename`
 * composes `<agent>: <task>` a peer addressing the bare identity gets
 * "Session not found".
 *
 * This module resolves an intercom `to` value against the live roster
 * (obtained through pi-intercom 0.12's extension-bus channel API) so the
 * extension can rewrite bare identities to their registered composite name
 * before the send reaches the broker — without modifying pi-intercom.
 */

export interface RosterSession {
	id?: string;
	name?: string;
}

export type TargetResolutionStatus = "exact" | "rewritten" | "ambiguous" | "not-found";

export interface TargetResolution {
	status: TargetResolutionStatus;
	/** The name to address, or null when no unique resolution exists. */
	name: string | null;
}

/** Extension-bus namespace this extension registers for identity traffic. */
export const IDENTITY_CHANNEL_NAMESPACE = "agent-identity/v1";

/**
 * Resolve an intercom `to` value against the live roster.
 *
 * 1. An exact (case-insensitive) match on roster name always wins.
 * 2. Otherwise fall back to sessions whose registered name is the composite
 *    form `${to}: <suffix>` (case-insensitive prefix). A single candidate is
 *    rewritten to its registered name; several are ambiguous; none means the
 *    target is not on the roster (the daemon-relay path handles revival).
 */
export function resolveIntercomTarget(
	to: string,
	sessions: readonly RosterSession[],
): TargetResolution {
	const wanted = to.trim().toLowerCase();
	if (!wanted) return { status: "not-found", name: null };

	for (const session of sessions) {
		if (session.name?.trim().toLowerCase() === wanted) {
			return { status: "exact", name: session.name!.trim() };
		}
	}

	const prefix = `${wanted}: `;
	let best: string | null = null;
	let ambiguous = false;
	for (const session of sessions) {
		const name = session.name?.trim();
		if (!name || !name.toLowerCase().startsWith(prefix)) continue;
		if (best && best.toLowerCase() !== name.toLowerCase()) ambiguous = true;
		else if (!best || name.length < best.length) best = name;
	}
	if (ambiguous) return { status: "ambiguous", name: null };
	if (best) return { status: "rewritten", name: best };
	return { status: "not-found", name: null };
}
