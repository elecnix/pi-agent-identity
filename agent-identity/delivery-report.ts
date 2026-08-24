/**
 * Honest relay reporting for failed intercom deliveries.
 *
 * Extracted from index.ts so the classification and wording are
 * unit-testable. The old behaviour labelled every `delivered: false` as
 * "target is offline" and promised a revival that may never happen — even
 * when the failure was merely a name-resolution miss against a live
 * session.
 */

/** What the daemon actually did with the relayed message. */
export type RelayOutcome = "live" | "revival" | "deferred" | "unresolved";

/**
 * Classify an intercom delivery-failure result.
 *
 * `details` is the tool-result `details` object emitted by the intercom
 * extension (`delivered: false`, plus optional `reason` / `code`).
 *
 * A "name-resolution miss" means the broker could not resolve the address
 * ("Session not found" / E_TARGET_NOT_FOUND) — the target may well be live
 * under a composite session name, so the sender must not be told it was
 * offline.
 */
export function isNameResolutionMiss(details: Record<string, unknown>): boolean {
	const reason = typeof details.reason === "string" ? details.reason : "";
	const code = typeof details.code === "string" ? details.code : "";
	if (code === "E_TARGET_NOT_FOUND") return true;
	return /session not found/i.test(reason);
}

/**
 * Build the honest report shown to the sending agent.
 *
 * - live:      the daemon delivered to a connected session (the earlier
 *              failure was a name-resolution miss, not an offline peer).
 * - revival:   the daemon actually revived (or will revive) the session.
 * - deferred:  the target process appears alive but unreachable; nothing
 *              was sent and no revival was attempted (avoids two writers
 *              on one session file).
 * - unresolved:no roster entry matched — say so instead of promising a
 *              revival.
 */
export function buildRelayReport(targetName: string, outcome: RelayOutcome): string {
	switch (outcome) {
		case "live":
			return [
				`📨 ${targetName} is online — your message was delivered directly.`,
				`(The earlier "Session not found" was a name-resolution miss, not an offline peer.)`,
			].join(" ");
		case "revival":
			return `⚠️ ${targetName} is offline. Message relayed via daemon — their session will be revived to pick it up.`;
		case "deferred":
			return `⚠️ ${targetName}'s session process appears to be running but is not reachable via the daemon. The message was NOT relayed — no revival was attempted to avoid two writers on one session.`;
		case "unresolved":
		default:
			return `⚠️ Could not deliver to ${targetName}: no matching agent in the roster, so nothing was relayed.`;
	}
}
