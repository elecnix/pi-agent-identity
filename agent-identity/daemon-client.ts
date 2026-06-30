/**
 * Daemon client — query the agent-identity daemon for session lookups.
 *
 * Extracted from index.ts so it can be tested directly.
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";

const DEFAULT_SOCKET_PATH = "/tmp/agent-identity-daemon.sock";

export function isDaemonRunning(socketPath: string = DEFAULT_SOCKET_PATH): boolean {
	return existsSync(socketPath);
}

/**
 * Resolve a --agent-name CLI flag value to a session file path.
 *
 * Returns null when the flag is unset, not a string, matches the current
 * agent name, or the target agent isn't registered in the daemon.
 */
export async function resolveTargetSession(
	flagValue: string | boolean | undefined,
	currentAgentName: string,
	socketPath: string = DEFAULT_SOCKET_PATH,
): Promise<string | null> {
	if (!flagValue || typeof flagValue !== "string") return null;
	if (flagValue === currentAgentName) return null;
	return await queryDaemonForSession(flagValue, socketPath);
}

/**
 * Query the daemon for an agent's session file path.
 * Connects, sends lookup_agent, returns sessionFile or null.
 */
export async function queryDaemonForSession(
	agentName: string,
	socketPath: string = DEFAULT_SOCKET_PATH,
): Promise<string | null> {
	if (!isDaemonRunning(socketPath)) return null;

	return new Promise((resolve) => {
		const sock = createConnection(socketPath);
		let buffer = "";

		const timeout = setTimeout(() => {
			try { sock.destroy(); } catch {}
			resolve(null);
		}, 2000);

		sock.on("connect", () => {
			sock.write(`${JSON.stringify({ type: "lookup_agent", agentName })}\n`);
		});

		sock.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line) as Record<string, unknown>;
					if (msg.type === "agent_found" && msg.sessionFile) {
						clearTimeout(timeout);
						try { sock.destroy(); } catch {}
						resolve(msg.sessionFile as string);
						return;
					}
					if (msg.type === "agent_not_found") {
						clearTimeout(timeout);
						try { sock.destroy(); } catch {}
						resolve(null);
						return;
					}
				} catch { /* ignore parse errors */ }
			}
		});

		sock.on("error", () => {
			clearTimeout(timeout);
			try { sock.destroy(); } catch {}
			resolve(null);
		});

		sock.on("close", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}
