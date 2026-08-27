/**
 * Fork identity disambiguation (#43).
 *
 * A forked subtask session (`subtask` / fork mechanism) is created by
 * copying the parent's entries verbatim — including the
 * `agent-identity-name` custom entry — with a new header that records
 * `parentSession`. The child therefore restores the parent's agent name and
 * both sessions come up live at the same time under the same name, which
 * breaks intercom addressing, commit attribution, and roster readability.
 *
 * The child is re-identified with a deterministic suffix derived from its
 * own session id (already unique per session), so the same fork always
 * presents the same name across daemon restarts and session reloads:
 *
 *   swift-koala-42            # parent (unchanged)
 *   swift-koala-42-a1b2c3d4   # child (suffix = session-id hash)
 *
 * The parent's identity stays stable, so PR mentions and revival addressing
 * keep working; the child becomes addressable and attributable on its own.
 */

import { createHash } from "node:crypto";

/** Length of the hex suffix appended to a forked child's name. */
const SUFFIX_LENGTH = 8;

/** Minimal shape of a session header (SessionManager.getHeader()). */
export interface SessionHeaderLike {
	parentSession?: string;
}

/**
 * Deterministic short hash of a session id. The session id is unique per
 * session, so the suffix is unique per fork and stable across restarts.
 */
export function forkSuffixFor(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, SUFFIX_LENGTH);
}

/** True when the session header records a parent — i.e. this is a fork. */
export function isForkedSession(header: SessionHeaderLike | null | undefined): boolean {
	return typeof header?.parentSession === "string" && header.parentSession.length > 0;
}

/** Compose the child identity: `<parentName>-<sessionIdHash>`. */
export function composeForkIdentity(parentName: string, sessionId: string): string {
	return `${parentName}-${forkSuffixFor(sessionId)}`;
}

/**
 * Re-identify a forked child session. Returns the suffixed name when the
 * session is a fork and the restored name is not already suffixed; otherwise
 * returns the name unchanged. Idempotent, so a reload of an already-suffixed
 * fork does not double-suffix.
 */
export function maybeSuffixForkIdentity(
	name: string,
	header: SessionHeaderLike | null | undefined,
	sessionId: string,
): string {
	if (!name) return name;
	if (!isForkedSession(header)) return name;
	if (name.endsWith(`-${forkSuffixFor(sessionId)}`)) return name;
	return composeForkIdentity(name, sessionId);
}
