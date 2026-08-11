/**
 * Format the notification injected into a session when its agent is
 * @mentioned on a GitHub PR or Linear ticket.
 *
 * This is **informational situation awareness**: the receiver is told that a
 * mention happened and where, but no response is expected unless the sender
 * explicitly asked a question or the receiver has substantive new
 * information that the sender needs. Replying purely to acknowledge, thank,
 * or "close the loop" is the failure mode this formatter exists to prevent.
 */

export interface MentionNotificationInput {
	/** The agent name that made the mention, e.g. "rapid-gecko-48". */
	from: string;
	/** The receiver's own agent name, e.g. "iron-panda-50". */
	agentName: string;
	/** The mention/comment body. Truncated to a bounded length. */
	body: string;
	/** Link to the PR/issue comment, or "" when unavailable. */
	url: string;
	/** PR number, or undefined for a Linear ticket / unknown surface. */
	prNumber?: number;
}

/** Maximum body length kept in the notification (matches the daemon's slice). */
const MAX_BODY = 800;

/**
 * Build the user-facing notification string for a PR/issue @mention.
 *
 * The wording is deliberately neutral and non-imperative: it reports the
 * event, points at the source, and tells the model that — unlike an intercom
 * `ask` — nothing is owed here. The only sanctioned reply is one that
 * contributes a real answer to an explicit question or substantive new
 * information the sender needs; otherwise the right action is to continue
 * current work.
 */
export function formatMentionNotification(input: MentionNotificationInput): string {
	const from = input.from?.trim() || "unknown";
	const agentName = input.agentName;
	const body = (input.body ?? "").slice(0, MAX_BODY);
	const url = input.url?.trim() ?? "";
	const prLabel = input.prNumber ? `PR #${input.prNumber}` : "a PR/issue";

	const lines: string[] = [
		`🔔 @${from} mentioned you (@${agentName}) in ${prLabel}:`,
		"",
		`> ${body}`,
		"",
	];

	if (url) {
		lines.push(url, "");
	}

	lines.push(
		`This is informational situation awareness — no response is expected.`,
		`Continue your current work. Only respond if @${from} explicitly asked`,
		`you a direct question, or you have substantive new information they`,
		`need; otherwise do not reply just to acknowledge, thank, or close the`,
		`loop.`,
	);

	return lines.join("\n");
}