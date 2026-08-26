/**
 * Agent Identity Extension
 *
 * Gives each pi session a unique random name so agents can @mention each other
 * on GitHub PRs and Linear tickets. When an agent sees an @mention of its own
 * name, it injects that mention into the session as informational situation
 * awareness (no response expected unless the sender asked a direct question).
 * Names are persisted across session reloads via pi.appendEntry().
 * Polling is handled by a detached singleton daemon (agent-identity-daemon).
 * The extension connects to the daemon via Unix socket to register and receive
 * mention notifications.
 */

import type { ExtensionAPI, BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { composeSessionName, SESSION_RENAME_TOOL_DESCRIPTION } from "./session-name.ts";
import { buildIdentityPrompt } from "./identity-prompt.ts";
import { execSync, spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { createConnection, Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDaemonRunning, listDaemonAgents, resolveTargetSession } from "./daemon-client.ts";
import { formatMentionNotification } from "./mention-notification.ts";
import { buildRelayReport, type RelayOutcome } from "./delivery-report.ts";
import {
	IDENTITY_CHANNEL_NAMESPACE,
	resolveIntercomTarget,
	type RosterSession,
} from "./intercom-addressing.ts";
import { pickFreshAgentName } from "./name-minting.ts";
import { formatAgentMatches, searchAgents, type AgentSearchEntry } from "./agent-search.ts";
import { buildAskRelayBody } from "./delivery-report.ts";
import { buildReplyRelayBody, extractFailedReplyTarget } from "./reply-fallback.ts";

// ─── Name generation ────────────────────────────────────────────────────────

const ADJECTIVES = [
	"swift", "brave", "crimson", "gentle", "mighty", "silent", "lunar", "solar",
	"rapid", "steady", "bright", "shadow", "frost", "ember", "crystal", "ancient",
	"vivid", "cosmic", "rusty", "golden", "silver", "azure", "amber", "jade",
	"violet", "scarlet", "copper", "iron", "polar", "tidal", "storm", "zenith",
	"hollow", "lucid", "feral", "noble", "quiet", "bold", "keen", "sage",
];

const ANIMALS = [
	"koala", "shark", "eagle", "panda", "dragon", "falcon", "otter", "wolf",
	"raven", "bear", "tiger", "lynx", "fox", "hawk", "orca", "crane",
	"viper", "badger", "heron", "lemur", "gecko", "ibis", "cobra", "sloth",
	"bison", "zebra", "civet", "tapir", "quail", "wren", "newt", "tahr",
	"okapi", "serval", "grouse", "condor", "marlin", "gar", "skua", "tern",
];

let agentName = "";
const seenMentionIds = new Set<number>();

function generateName(): string {
	const adj = ADJECTIVES[randomInt(0, ADJECTIVES.length)];
	const animal = ANIMALS[randomInt(0, ANIMALS.length)];
	const num = randomInt(0, 100);
	return `${adj}-${animal}-${num}`;
}

// ─── Daemon connection state ────────────────────────────────────────────────

/** Protocol version — must match daemon.ts. On mismatch, daemon is auto-restarted. */
const PROTOCOL_VERSION = 1;

const SOCKET_PATH = "/tmp/agent-identity-daemon.sock";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(EXTENSION_DIR, "daemon.ts");

type ConnState = "disconnected" | "connecting" | "connected";

let connState: ConnState = "disconnected";
let socket: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 1000; // starts at 1s, backs off to max 30s
let sessionFile: string | null = null;
let piRef: ExtensionAPI | null = null;
let updateStatus: ((state: ConnState) => void) | null = null;
let shuttingDown = false;

/**
 * Pending daemon-relay requests keyed by target name. The tool_result hook
 * writes queue_mention and waits for the daemon's mention_queued verdict so
 * the reported outcome reflects what actually happened (live delivery,
 * revival, deferred, or unresolved) instead of a fabricated "offline" story.
 */
const RELAY_VERDICT_TIMEOUT_MS = 3000;
const pendingRelays = new Map<
	string,
	{ resolve: (outcome: RelayOutcome) => void; timer: ReturnType<typeof setTimeout> }
>();

/**
 * pi-intercom ≥ 0.12 extension-bus channel (minimal local shape).
 * Mirrored as string literals + loose types so this extension keeps no hard
 * runtime dependency on the pi-intercom package.
 */
const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";

interface IntercomIdentityChannel {
	snapshot(): { connected: boolean; supported: boolean };
	listSessions(): Promise<RosterSession[]>;
	publish(payload: unknown, options?: unknown): void;
}

let identityChannel: IntercomIdentityChannel | null = null;

function announceIdentity(): void {
	if (!identityChannel || !agentName) return;
	try {
		identityChannel.publish({ agentName });
	} catch {}
}

function setConnState(state: ConnState) {
	connState = state;
	try { updateStatus?.(state); } catch {}
}

// ─── Daemon helpers ──────────────────────────────────────────────────────────


function spawnDaemon(): boolean {
	try {
		if (!existsSync(DAEMON_SCRIPT)) {
			return false;
		}

		const nodeBin = process.execPath || "node";
		const child = spawn(nodeBin, ["--experimental-strip-types", DAEMON_SCRIPT], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env },
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function connectToDaemon(): void {
	if (shuttingDown) return;
	if (connState === "connecting" || connState === "connected") return;
	if (!agentName || !sessionFile) return;

	setConnState("connecting");

	// Try to spawn daemon if not running
	if (!isDaemonRunning()) {
		const spawned = spawnDaemon();
		if (!spawned) {
			scheduleReconnect();
			return;
		}
		// Daemon was just spawned — give it time to bind, then retry.
		// Poll every 100ms for up to 3s until the socket file appears.
		// Without this wait, createConnection races the daemon bind and
		// the connection attempt either errors or succeeds silently with
		// no listener — in both cases the handshake hangs forever.
		let attempts = 0;
		const poll = () => {
			if (isDaemonRunning()) {
				// Socket exists — proceed with connection (reset state so
				// the "connecting" guard doesn't block re-entry).
				connState = "disconnected";
				connectToDaemon();
			} else if (++attempts < 30) {
				setTimeout(poll, 100);
			} else {
				setConnState("disconnected");
				socket = null;
				scheduleReconnect();
			}
		};
		poll();
		return;
	}

	const sock = createConnection(SOCKET_PATH);
	let handshakeTimeout: ReturnType<typeof setTimeout> | null = null;

	let buffer = "";
	let versionOk = false;

	sock.on("connect", () => {
		// Phase 1: version check
		sock.write(
			JSON.stringify({ type: "version_check", version: PROTOCOL_VERSION }) + "\n",
		);
	});

	sock.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? ""; // keep incomplete line

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as Record<string, unknown>;

				// ── Version check phase ──────────────────────────────────
				if (!versionOk) {
					if (msg.type === "version_ok") {
						if (handshakeTimeout) { clearTimeout(handshakeTimeout); handshakeTimeout = null; }
						versionOk = true;
						setConnState("connected");
						reconnectDelay = 1000;

						// Phase 2: register
						let repo: string | undefined;
						try {
							const remote = execSync("git remote get-url origin", {
								encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
							}).trim();
							const m = remote.match(/github\.com[:/]([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
							if (m) repo = m[1] + "/" + m[2];
						} catch {}

						sock.write(
							JSON.stringify({
								type: "register",
								agentName,
								sessionFile,
								pid: process.pid,
								repo,
								cwd: process.cwd(),
							}) + "\n",
						);

						// Start pings
						pingTimer = setInterval(() => {
							if (sock.writable) {
								sock.write(JSON.stringify({ type: "ping" }) + "\n");
							}
						}, 30_000);
						continue;
					}

					// Daemon sent version_mismatch. If daemon expected > ours,
					// it's newer — accept it instead of downgrading.
					if (
					msg.type === "version_mismatch" &&
					typeof msg.expected === "number" &&
					msg.expected > PROTOCOL_VERSION
				) {
						// Daemon is newer — register without restarting
					if (handshakeTimeout) { clearTimeout(handshakeTimeout); handshakeTimeout = null; }
					versionOk = true;
					setConnState("connected");
					reconnectDelay = 1000;
					let repo: string | undefined;
					try {
						const remote = execSync("git remote get-url origin", {
							encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
						}).trim();
						const m = remote.match(/github\.com[:/]([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
						if (m) repo = m[1] + "/" + m[2];
					} catch {}
					sock.write(
						JSON.stringify({
							type: "register",
							agentName,
							sessionFile,
							pid: process.pid,
							repo,
							cwd: process.cwd(),
						}) + "\n",
					);
					pingTimer = setInterval(() => {
						if (sock.writable) {
							sock.write(JSON.stringify({ type: "ping" }) + "\n");
						}
					}, 30_000);
					continue;
				}

				// Old daemon that doesn't understand version_check
					// responds with error, or mismatch response.
					// Kill it and respawn the current version.
					if (
						msg.type === "version_mismatch" ||
						(msg.type === "error" && typeof msg.message === "string" &&
							msg.message.includes("version_check"))
					) {
						setConnState("disconnected");
						cleanupSocket();
						// Kill stale daemon
						try {
							const pidRaw = readFileSync("/tmp/agent-identity-daemon.pid", "utf-8").trim();
							const pid = parseInt(pidRaw, 10);
							if (!isNaN(pid)) process.kill(pid, "SIGTERM");
						} catch {}
						// Wait briefly for socket cleanup, then reconnect
						setTimeout(() => {
							connectToDaemon();
						}, 500);
						return;
					}

					// Any other message before version_ok is unexpected —
					// treat as stale daemon.
					setConnState("disconnected");
					cleanupSocket();
					try {
						const pidRaw = readFileSync("/tmp/agent-identity-daemon.pid", "utf-8").trim();
						const pid = parseInt(pidRaw, 10);
						if (!isNaN(pid)) process.kill(pid, "SIGTERM");
					} catch {}
					setTimeout(() => {
						connectToDaemon();
					}, 500);
					return;
				}

				// ── Normal message handling ───────────────────────────────
				handleDaemonMessage(msg);
			} catch {
				// ignore parse errors
			}
		}
	});

	sock.on("close", () => {
		if (handshakeTimeout) { clearTimeout(handshakeTimeout); handshakeTimeout = null; }
		setConnState("disconnected");
		cleanupSocket();
		failPendingRelays();
		scheduleReconnect();
	});

	sock.on("error", () => {
		if (handshakeTimeout) { clearTimeout(handshakeTimeout); handshakeTimeout = null; }
		setConnState("disconnected");
		cleanupSocket();
		failPendingRelays();
		scheduleReconnect();
	});

	// If the handshake doesn't complete within 5s, treat the connection as
	// dead. This recovers from stale sockets where createConnection succeeds
	// but the peer never responds (e.g. daemon crashed between bind and
	// accept, or the socket fd is orphaned).
	handshakeTimeout = setTimeout(() => {
		if (!versionOk && socket) {
			setConnState("disconnected");
			cleanupSocket();
			scheduleReconnect();
		}
	}, 5000);

	socket = sock;
}

function handleDaemonMessage(msg: Record<string, unknown>): void {
	if (msg.type === "mention_queued") {
		const targetName = typeof msg.targetName === "string" ? msg.targetName : "";
		const pending = targetName ? pendingRelays.get(targetName) : undefined;
		if (pending) {
			pendingRelays.delete(targetName);
			clearTimeout(pending.timer);
			const method = msg.method;
			pending.resolve(
				method === "live" || method === "revival" || method === "deferred"
					? method
					: "unresolved",
			);
		}
		return;
	}

	if (msg.type === "mention" && piRef && agentName) {
		const from = (msg.from as string) ?? "unknown";
		const body = (msg.body as string) ?? "";
		const url = (msg.url as string) ?? "";
		const prNumber = msg.prNumber as number | undefined;
		const commentId = msg.commentId as number | undefined;

		if (commentId !== undefined && seenMentionIds.has(commentId)) return;
		if (commentId !== undefined) seenMentionIds.add(commentId);

		try {
			piRef.sendUserMessage(
				formatMentionNotification({ from, agentName, body, url, prNumber }),
			);
		} catch {
			// Agent busy — daemon will retry later
		}
	}
}

function cleanupSocket(): void {
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
	if (socket) {
		try { socket.destroy(); } catch {}
		socket = null;
	}
}

/** Settle every pending relay as unresolved (daemon connection lost). */
function failPendingRelays(): void {
	for (const [name, pending] of pendingRelays) {
		clearTimeout(pending.timer);
		pending.resolve("unresolved");
		pendingRelays.delete(name);
	}
}

function scheduleReconnect(): void {
	if (shuttingDown || reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		if (shuttingDown) return;
		reconnectTimer = null;
		connectToDaemon();
		reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
	}, reconnectDelay);
}

function disconnectFromDaemon(unregister = false): void {
	shuttingDown = true;
	if (socket && socket.writable && agentName && unregister) {
		try {
			socket.write(
				JSON.stringify({ type: "unregister", agentName }) + "\n",
			);
		} catch {}
	}
	cleanupSocket();
	setConnState("disconnected");
}

// ─── Git commit hook ─────────────────────────────────────────────────────────

function checkBashForGitCommit(event: BashToolCallEvent): void {
	if (!agentName) return;

	const cmd = event.input.command ?? "";
	if (!/\bgit\s+commit\b/.test(cmd)) return;
	if (/Co-authored-by:/.test(cmd)) return;
	if (/--trailer\s/.test(cmd)) return;
	if (/--no-edit/.test(cmd)) return;

	const trailer = `"Co-authored-by: ${agentName} <${agentName}@pi-agent.local>"`;
	if (cmd.includes(" -m ") || cmd.includes(' -m"') || cmd.includes(" -m'")) {
		event.input.command = cmd.replace(/(\bgit\s+commit\b.*)$/, `$1 --trailer ${trailer}`);
	} else if (/\bgit\s+commit\s*$/.test(cmd.trim())) {
		event.input.command = `${cmd} --trailer ${trailer}`;
	}
}

// ─── Extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	piRef = pi;

	// ── Restore or generate agent name ────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		// Reset module-level state — /new reuses the same extension module
		shuttingDown = false;
		agentName = "";

		// Restore from existing session entries
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === "agent-identity-name"
			) {
				const data = entry.data as { name: string } | undefined;
				if (data?.name) {
					agentName = data.name;
				}
			}
			if (
				entry.type === "custom" &&
				entry.customType === "agent-identity-seen"
			) {
				const data = entry.data as { ids: number[] } | undefined;
				if (data?.ids) {
					for (const id of data.ids) seenMentionIds.add(id);
				}
			}
		}

		// Generate if not restored (or use env var for testing)
		if (!agentName) {
			const envName = process.env["AGENT_IDENTITY_NAME"];
			if (envName) {
				agentName = envName;
			} else {
				// Collision-free mint (#34): a name still in the daemon roster
				// belongs to a disconnected-but-revivable agent whose ghost
				// intercom session would swallow this session's messages.
				const takenNames = new Set<string>();
				try {
					for (const agent of await listDaemonAgents()) takenNames.add(agent.name);
				} catch {}
				agentName = pickFreshAgentName(generateName, takenNames);
			}
			pi.appendEntry("agent-identity-name", { name: agentName });
		}

		// Set session name
		pi.setSessionName(agentName);

		// Capture session file path
		sessionFile = ctx.sessionManager.getSessionFile();

		// ── Handle --agent-name flag: resolve and revive target session ──
		const flagValue = pi.getFlag("agent-name");
		if (flagValue && typeof flagValue === "string" && flagValue !== agentName) {
			const targetSession = await resolveTargetSession(flagValue, agentName);
			if (!targetSession) {
				// Not in the daemon and no matching session file on disk —
				// warn but continue with a fresh session.
				if (ctx.hasUI) {
					ctx.ui.notify(`No session found for agent "${flagValue}"`, "warning");
				}
			} else {
				// Replace the current process with pi pointed at the target
				// session.  spawnSync with stdio: "inherit" blocks the parent
				// while the child owns the terminal.  When the child exits, we
				// follow with the same exit code.
				const result = spawnSync(
					process.env["PI_CMD"] ?? "pi",
					["--session", targetSession],
					{ stdio: "inherit", env: { ...process.env } },
				);
				if (result.error) {
					// Failed to spawn — fall through to normal startup
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Failed to launch pi: ${result.error.message}`,
							"error",
						);
					}
				} else {
					process.exit(result.status ?? (result.signal ? 1 : 0));
				}
			}
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Agent identity: ${agentName}`, "info");
			ctx.ui.setStatus("agent-identity", `🟡 ${agentName} (connecting to daemon...)`);
			// Safe status updater bound to this session's ctx
			updateStatus = (state: ConnState) => {
				try {
					const icon = state === "connected" ? "🟢" : state === "connecting" ? "🟡" : "🔴";
					ctx.ui.setStatus("agent-identity", `${icon} ${agentName} (${state})`);
				} catch {}
			};
		}

		// Connect to daemon (updates status on success/failure)
		connectToDaemon();

		// ── Register intercom identity via the extension bus ────────────
		// Publishes the immutable agentName on pi-intercom's silent extension
		// bus and gives this session a live-roster handle for address
		// resolution. Older pi-intercom versions ignore unknown events.
		try {
			pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
				namespace: IDENTITY_CHANNEL_NAMESPACE,
				ownerEligible: true,
				onReady: (channel: IntercomIdentityChannel) => {
					identityChannel = channel;
					announceIdentity();
				},
				onEvent: (_event: unknown) => {},
			});
		} catch {}
	});

	// ── Inject identity into system prompt ────────────────────────────────
	// Guard against duplicate injection (extension may be loaded twice).
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!agentName) return;
		const currentPrompt = event.systemPrompt ?? "";
		// Idempotency: skip if identity block already present
		if (currentPrompt.includes("<agent_identity>")) return;
		const identityBlock = buildIdentityPrompt(agentName);
		return {
			systemPrompt: currentPrompt + "\n" + identityBlock,
		};
	});

	// ── Intercom auto-reply enforcement ──────────────────────────────────
	// When an intercom message just arrived, force the agent to use intercom
	pi.on("context", async (event) => {
		const msgs = event.messages;
		// Find the most recent intercom_message
		let lastIntercomIdx = -1;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as any;
			if (m?.customType === "intercom_message") {
				lastIntercomIdx = i;
				break;
			}
		}
		if (lastIntercomIdx === -1) return;

		// Idempotency: if directive already injected right before, skip
		if (lastIntercomIdx > 0) {
			const prev = msgs[lastIntercomIdx - 1] as any;
			if (prev?.content?.[0]?.text?.includes("DO NOT reply in normal chat")) {
				return;
			}
		}

		// Check if this intercom message has already been replied to via intercom
		let alreadyReplied = false;
		for (let i = lastIntercomIdx + 1; i < msgs.length; i++) {
			const m = msgs[i] as any;
			if (m?.type === "tool_call" && m?.toolName === "intercom") {
				alreadyReplied = true;
				break;
			}
		}
		if (alreadyReplied) return;

		// Inject a gentle reminder before the intercom message
		const directive = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "📨 Intercom message above. Respond with intercom({ action: \"reply\", message: \"...\" }) only if you have something meaningful to say. If the sender used ask they are blocked — reply promptly. Otherwise, if there is nothing to add, just continue working without replying." }],
		};

		// Insert right before the intercom message
		const modified = [...msgs];
		modified.splice(lastIntercomIdx, 0, directive as any);
		return { messages: modified };
	});

	// ── Intercom failure → daemon relay ──────────────────────────────────
	// When intercom send/ask/reply fails, route via daemon and report honestly.
	// Disconnected agents already appear in the intercom broker's session list
	// via ghost registration (daemon.ts), so no separate augmentation is needed.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "intercom") return;

		const input = event.input as Record<string, unknown>;

		// Intercom delivery failure → daemon relay
		if (event.details) {
			const d = event.details as Record<string, unknown>;
			const delivered = d.delivered;
			if (delivered === false) {
				const action = typeof input.action === "string" ? input.action : "";
				const messageBody = input.message as string | undefined;

				// Reply failures don't carry `to` — pi-intercom only names the
				// target in the human-readable result text (#6).
				let targetName: string | undefined;
				if (action === "reply") {
					targetName = (typeof input.to === "string" && input.to.trim())
						? input.to
						: extractFailedReplyTarget(
							(event.content as Array<{ type?: string; text?: string }> | undefined)
								?.find((c) => c?.type === "text")?.text,
						);
				} else {
					targetName = input.to as string | undefined;
				}

				if (!targetName || !messageBody) return;
				if (!agentName || !socket?.writable) return;

				// A relayed reply is explicitly an async reply to the original thread;
				// a relayed ask tells the revived peer to answer back (#8).
				const body = action === "reply"
					? buildReplyRelayBody(agentName, messageBody)
					: action === "ask"
						? buildAskRelayBody(agentName, messageBody)
						: messageBody;
				const wasAsk = action === "ask";

				// Ask the daemon to deliver/relay, then wait for its verdict so
				// the wording matches reality (live / revival / deferred /
				// unresolved) instead of always claiming an offline peer.
				const outcome = await new Promise<RelayOutcome>((resolve) => {
					const timer = setTimeout(() => {
						pendingRelays.delete(targetName);
						resolve("unresolved");
					}, RELAY_VERDICT_TIMEOUT_MS);
					pendingRelays.set(targetName, { resolve, timer });
					try {
						socket!.write(JSON.stringify({
							type: "queue_mention",
							targetName,
							fromName: agentName,
							body,
						}) + "\n");
					} catch {
						pendingRelays.delete(targetName);
						clearTimeout(timer);
						resolve("unresolved");
					}
				});

				return {
					content: [{
						type: "text",
						text: buildRelayReport(targetName, outcome, { wasAsk }),
					}],
					details: {
						...d,
						relayed: outcome === "live" || outcome === "revival",
						relayMethod: outcome,
					},
				};
			}
		}
	});

	// ── Git commit co-author hook ─────────────────────────────────────────
	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName !== "bash") return;
		if (!isToolCallEventType("bash", event)) return;
		checkBashForGitCommit(event);
	});

	// ── Intercom addressing via the immutable agent identity ──────────────
	// pi-intercom resolves `to` by exact registered name only; after
	// session_rename composes `<agent>: <task>` a peer addressing the bare
	// agent identity gets "Session not found". Rewrite bare identities to
	// their unique composite roster name before the send reaches the broker.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "intercom") return;
		if (!identityChannel) return;
		const input = event.input as Record<string, unknown>;
		const action = input.action;
		if (action !== "send" && action !== "ask") return;
		const to = input.to;
		if (typeof to !== "string" || !to.trim()) return;
		let snap: { connected?: boolean; supported?: boolean } | undefined;
		try {
			snap = identityChannel.snapshot();
		} catch {
			return;
		}
		if (!snap?.connected || !snap.supported) return;
		try {
			const sessions = await identityChannel.listSessions();
			const resolved = resolveIntercomTarget(to, sessions);
			if (resolved.status === "rewritten" && resolved.name) {
				input.to = resolved.name;
			}
		} catch {
			// Roster unavailable — leave the address untouched; the relay hook
			// handles any resulting delivery failure honestly.
		}
	});

	// ── Cleanup on shutdown ───────────────────────────────────────────────
	pi.on("session_shutdown", async (_event, ctx) => {
		// Persist seen mentions
		if (seenMentionIds.size > 0) {
			pi.appendEntry("agent-identity-seen", {
				ids: Array.from(seenMentionIds).slice(-500),
			});
		}

		// Disconnect from daemon (don't unregister — allow revival)
		disconnectFromDaemon(false);

		// Clear status updater and UI
		updateStatus = null;
		ctx.ui.setStatus("agent-identity", undefined);

		piRef = null;
	});

	// ── Register agent_search tool ─────────────────────────────────────
	// Address a peer knowing only a short name fragment — far cheaper than
	// listing hundreds of intercom sessions into the transcript.
	pi.registerTool({
		name: "agent_search",
		label: "Search Agents",
		description:
			"Search registered agents by (partial) name. Returns matching agent names, their full registered intercom names when renamed, and online/offline status. Use this instead of intercom list when you only know a short name fragment.",
		promptSnippet:
			"Find an agent's addressable name from a short fragment without dumping the full session roster.",
		promptGuidelines: [
			"Before sending intercom messages to an unfamiliar or ambiguous name, use agent_search to resolve the exact address.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"A full or partial agent name, e.g. 'cosmic' or 'keen-gar-77'. Exact matches rank first.",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of matches to return (default 10).",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const query = typeof params.query === "string" ? params.query : "";
			if (!query.trim()) {
				return {
					content: [{ type: "text", text: "No query provided." }],
					details: { ok: false, query },
				};
			}

			// Gather candidates from the daemon registry and the live roster.
			const byName = new Map<string, AgentSearchEntry>();
			try {
				for (const agent of await listDaemonAgents()) {
					byName.set(agent.name, {
						name: agent.name,
						connected: agent.connected,
						...(agent.ghostSessionId ? { ghostSessionId: agent.ghostSessionId } : {}),
					});
				}
			} catch {}
			if (identityChannel) {
				try {
					const snap = identityChannel.snapshot();
					if (snap.connected && snap.supported) {
						for (const session of await identityChannel.listSessions()) {
							const rosterName = typeof session.name === "string" ? session.name.trim() : "";
							if (!rosterName) continue;
							const bare = rosterName.split(": ")[0]!;
							const existing = byName.get(bare);
							byName.set(bare, {
								name: bare,
								rosterName,
								connected: existing?.connected ?? true,
								ghostSessionId: existing?.ghostSessionId,
							});
						}
					}
				} catch {}
			}

			const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 10;
			const hits = searchAgents(query, Array.from(byName.values()), limit);

			return {
				content: [{ type: "text", text: formatAgentMatches(query, hits) }],
				details: { ok: true, query, count: hits.length, hits },
			};
		},
	});

	// ── Register session_rename tool ───────────────────────────────────
	// The agent renames its own session to reflect the task, keeping the
	// agent name as the prefix. Registered unconditionally (not inside
	// session_start) so the tool is available on the very first turn.
	pi.registerTool({
		name: "session_rename",
		label: "Rename Session",
		description: SESSION_RENAME_TOOL_DESCRIPTION,
		promptSnippet:
			"Rename the current pi session; call it AS SOON AS the first user message conveys intent, before doing substantive work.",
		promptGuidelines: [
			"Call session_rename immediately after reading the user's first message — before any other tool use — so the session name reflects the task early.",
		],
		parameters: Type.Object({
			session_name: Type.String({
				description:
					"A short, kebab-case description of the task (e.g. 'fix-auth-bug', 'PRI-123-add-router-config'). The agent-name prefix is added automatically — provide the description only.",
			}),
		}),
		async execute(_toolCallId, params) {
			const desired = params.session_name ?? "";
			// Compose the full name: <agentName>: <description>.
			const fullName = composeSessionName(agentName, desired);

			try {
				pi.setSessionName(fullName);
			} catch (err) {
				return {
					content: [{
						type: "text" as const,
						text: `Failed to rename session: ${err instanceof Error ? err.message : String(err)}`,
					}],
					details: { ok: false, agentName, desired, fullName },
				};
			}

			// Re-announce the immutable identity on the extension bus — the
			// roster name changed, so peers should re-resolve addresses.
			announceIdentity();

			return {
				content: [{
					type: "text" as const,
					text: `Session renamed to: ${fullName}`,
				}],
				details: { ok: true, agentName, desired, fullName },
			};
		},
	});

	// ── Register /whoami command ──────────────────────────────────────────
	pi.registerCommand("whoami", {
		description: "Show your agent identity name",
		handler: async (_args, ctx) => {
			if (agentName) {
				ctx.ui.notify(`You are: ${agentName}`, "info");
			} else {
				ctx.ui.notify("No agent identity assigned.", "warning");
			}
		},
	});

	// ── Register /agent-status command ────────────────────────────────────
	pi.registerCommand("agent-status", {
		description: "Show daemon connection status and agent info",
		handler: async (_args, ctx) => {
			const stateLabel =
				connState === "connected"
					? "🟢 connected"
					: connState === "connecting"
						? "🟡 connecting"
						: "🔴 disconnected";
			ctx.ui.notify(
				[
					`Agent: ${agentName || "(not assigned)"}`,
					`Daemon: ${stateLabel}`,
					`Session: ${sessionFile || "(none)"}`,
					`Seen mentions: ${seenMentionIds.size}`,
					`Socket: ${SOCKET_PATH}`,
				].join(" | "),
				"info",
			);
		},
	});

	// ── Register /agent-reconnect command ─────────────────────────────────
	pi.registerCommand("agent-reconnect", {
		description: "Force reconnect to the agent identity daemon",
		handler: async (_args, ctx) => {
			disconnectFromDaemon(false);
			reconnectDelay = 1000;
			ctx.ui.notify("Reconnecting to daemon...", "info");
			connectToDaemon();
		},
	});

	// ── Register /resume-agent command ──────────────────────────────────
	pi.registerCommand("resume-agent", {
		description: "Switch to another agent's session by name",
		handler: async (args, ctx) => {
			const targetName = args.trim();
			if (!targetName) {
				ctx.ui.notify("Usage: /resume-agent <agent-name>", "warning");
				return;
			}

			if (targetName === agentName) {
				ctx.ui.notify(`Already running as ${agentName}`, "info");
				return;
			}

			ctx.ui.notify(`Looking up agent "${targetName}"...`, "info");

			const sessionPath = await resolveTargetSession(targetName, agentName);
			if (!sessionPath) {
				ctx.ui.notify(`No session found for agent "${targetName}"`, "error");
				return;
			}

			await ctx.switchSession(sessionPath);
		},
	});

	// ── Register --agent-name flag ───────────────────────────────────────
	pi.registerFlag("agent-name", {
		description: "Resolve session by agent name via the agent-identity daemon",
		type: "string",
	});
}
