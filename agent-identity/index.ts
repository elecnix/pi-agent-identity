/**
 * Agent Identity Extension
 *
 * Gives each pi session a unique random name so agents can @mention each other
 * on GitHub PRs and Linear tickets. When an agent sees an @mention of its own
 * name, it injects that mention into the session so the LLM can respond.
 *
 * Names are persisted across session reloads via pi.appendEntry().
 * Polling is handled by a detached singleton daemon (agent-identity-daemon).
 * The extension connects to the daemon via Unix socket to register and receive
 * mention notifications.
 */

import type { ExtensionAPI, BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execSync, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { createConnection, Socket } from "node:net";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

function setConnState(state: ConnState) {
	connState = state;
	try { updateStatus?.(state); } catch {}
}

// ─── System prompt fragment ──────────────────────────────────────────────────

function buildIdentityPrompt(name: string): string {
	return `
<agent_identity>
YOUR AGENT NAME: ${name}

You are part of a community of AI coding agents that collaborate across sessions.
Strictly follow these identity rules:

1. **Commit co-authorship**: When you commit, ALWAYS include a Co-authored-by trailer:
   \`Co-authored-by: ${name} <${name}@pi-agent.local>\`

2. **PR descriptions**: When you create or update a pull request description, append the line:
   \`— ${name}\` at the very end (on its own line).

3. **Linear tickets**: When commenting on or updating a Linear issue, append \`— ${name}\` at the very end.

4. **@mentioning other agents**: You can @mention other agents by their lowercase-kebab name in GitHub PR comments and Linear issue comments. They will detect your mention and respond.

5. **Responding to @mentions**: When you see that @${name} has been mentioned (the system will inject these notifications), respond as yourself, addressing whoever mentioned you by their agent name.

6. **Code exclusion**: NEVER include your agent name "${name}" in source code, configuration files, or any file content. Your identity belongs ONLY in version-control metadata (commit trailers, PR descriptions, issue comments).

7. **Intercom messages**: When you receive a 📨 message from another agent via intercom, you MUST respond through the intercom tool — NOT in the normal chat. Use \`intercom({ action: "reply", message: "..." })\`. If it's an ask, the sender is blocked waiting — reply promptly. Treat other agents as peer collaborators: engage naturally, ask questions, share findings.

8. **Session name**: Your session is named "${name}" — use /name to see it.
</agent_identity>`;
}

// ─── Daemon helpers ──────────────────────────────────────────────────────────

function isDaemonRunning(): boolean {
	return existsSync(SOCKET_PATH);
}

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
	}

	const sock = createConnection(SOCKET_PATH);

	let buffer = "";

	sock.on("connect", () => {
		setConnState("connected");
		reconnectDelay = 1000; // reset backoff

		// Detect repo from git remote for daemon registration
		let repo: string | undefined;
		try {
			const remote = execSync("git remote get-url origin", {
				encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
			}).trim();
			const m = remote.match(/github\.com[:/]([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
			if (m) repo = m[1] + "/" + m[2];
		} catch {}

		// Register
		sock.write(
			JSON.stringify({
				type: "register",
				agentName,
				sessionFile,
				pid: process.pid,
				repo,
			}) + "\n",
		);

		// Start pings
		pingTimer = setInterval(() => {
			if (sock.writable) {
				sock.write(JSON.stringify({ type: "ping" }) + "\n");
			}
		}, 30_000);
	});

	sock.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? ""; // keep incomplete line

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				handleDaemonMessage(msg);
			} catch {
				// ignore parse errors
			}
		}
	});

	sock.on("close", () => {
		setConnState("disconnected");
		cleanupSocket();
		scheduleReconnect();
	});

	sock.on("error", () => {
		setConnState("disconnected");
		cleanupSocket();
		scheduleReconnect();
	});

	socket = sock;
}

function handleDaemonMessage(msg: Record<string, unknown>): void {
	if (msg.type === "mention" && piRef && agentName) {
		const from = (msg.from as string) ?? "unknown";
		const body = (msg.body as string) ?? "";
		const url = (msg.url as string) ?? "";
		const prNumber = msg.prNumber as number | undefined;
		const commentId = msg.commentId as number | undefined;

		if (commentId !== undefined && seenMentionIds.has(commentId)) return;
		if (commentId !== undefined) seenMentionIds.add(commentId);

		const prLabel = prNumber ? `PR #${prNumber}` : "a PR/issue";

		try {
			piRef.sendUserMessage(
				[
					`🔔 @${from} mentioned you (@${agentName}) in ${prLabel}:`,
					"",
					`> ${body.slice(0, 800)}`,
					"",
					url,
					"",
					`Respond to this mention naturally. Identify yourself as ${agentName} and reply to @${from}.`,
				].join("\n"),
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
				agentName = generateName();
			}
			pi.appendEntry("agent-identity-name", { name: agentName });
		}

		// Set session name
		pi.setSessionName(agentName);

		// Capture session file path
		sessionFile = ctx.sessionManager.getSessionFile();

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

		// Inject a forceful instruction before the intercom message
		const directive = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "⚠️ You just received an intercom message from another agent. DO NOT reply in normal chat. You MUST respond using the intercom tool: intercom({ action: \"reply\", message: \"...\" }). Replying in chat means the sender will never see your response." }],
		};

		// Insert right before the intercom message
		const modified = [...msgs];
		modified.splice(lastIntercomIdx, 0, directive as any);
		return { messages: modified };
	});

	// ── Intercom failure → daemon relay ──────────────────────────────────
	// When intercom send/ask fails (session not found), route via daemon.
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
				const targetName = input.to as string | undefined;
				const messageBody = input.message as string | undefined;
				if (!targetName || !messageBody) return;
				if (!agentName || !socket?.writable) return;

				socket.write(JSON.stringify({
					type: "queue_mention",
					targetName,
					fromName: agentName,
					body: messageBody,
				}) + "\n");

				return {
					content: [{
						type: "text",
						text: `⚠️ ${targetName} is offline. Message relayed via daemon — they'll be revived and respond shortly.`,
					}],
					details: { ...d, relayed: true, relayMethod: "daemon-revival" },
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
}
