/**
 * Reply-relay fallback (#6).
 *
 * When `intercom({ action: "reply" })` fails because the original sender's
 * session was cleaned up, the reply text can still reach them: the daemon
 * can revive their session with the reply injected as a mention. The relay
 * hook needs (a) the failed target's name — pi-intercom only reports it in
 * the human-readable result text, not in details — and (b) a body that
 * makes clear this is an asynchronous reply to the earlier thread.
 */

/**
 * Extract the target name from a failed-reply result text.
 *
 * Matches pi-intercom's wording:
 *   Reply to "<name-or-id>" was not delivered: <reason>
 * Returns null for any other text.
 */
export function extractFailedReplyTarget(contentText: string | undefined | null): string | null {
	if (typeof contentText !== "string" || !contentText) return null;
	const match = contentText.match(/Reply to "(.+?)" was not delivered:/);
	return match ? match[1]! : null;
}

/** Build the mention body relayed to the revived offline peer. */
export function buildReplyRelayBody(fromName: string, replyText: string): string {
	return [
		`📨 Asynchronous reply from @${fromName} (their intercom reply could not be delivered directly):`,
		"",
		replyText.slice(0, 800),
		"",
		'Reply using intercom({ action: "reply", message: "..." }).',
	].join("\n");
}
