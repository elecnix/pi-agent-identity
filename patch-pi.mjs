#!/usr/bin/env node
/**
 * Patches pi's main.js to add --agent-name flag and daemon-based
 * session resolution (--session <agent-name>).
 *
 * Runs as a postinstall script on pi install/update.
 * Idempotent — skips if already patched.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";

// ─── Locate pi's main.js ────────────────────────────────────────────────────

function findPiMainJs() {
  try {
    const piPath = execSync("which pi", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const piReal = execSync(`readlink -f "${piPath}"`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const mainJs = resolve(dirname(piReal), "main.js");
    if (existsSync(mainJs)) return mainJs;
  } catch {}

  const home = process.env["HOME"] ?? "/tmp";
  try {
    const found = execSync(
      `find ${home}/.local/share/pi-node -name main.js -path "*/pi-coding-agent/dist/*" 2>/dev/null | head -1`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, shell: "/bin/bash" }
    ).trim();
    if (found && existsSync(found)) return found;
  } catch {}

  return null;
}

// ─── Patch ──────────────────────────────────────────────────────────────────

const MARKER = "resolveFromAgentIdentityDaemon"; // presence = already patched

function patch(content) {
  if (content.includes(MARKER)) return null;

  // 1. Add imports: existsSync, createConnection
  const importLine = `import { createInterface } from "node:readline";`;
  if (!content.includes(importLine)) return null;
  content = content.replace(
    importLine,
    `import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";`
  );

  // 2. Insert daemon query function before resolveSessionPath
  const daemonFn = `
/** Agent identity daemon socket path (matches pi-agent-identity extension) */
const AGENT_DAEMON_SOCKET = "/tmp/agent-identity-daemon.sock";

async function resolveFromAgentIdentityDaemon(agentName) {
    if (!existsSync(AGENT_DAEMON_SOCKET)) return null;
    return new Promise((resolve) => {
        const sock = createConnection(AGENT_DAEMON_SOCKET);
        let buf = "";
        const t = setTimeout(() => { try { sock.destroy(); } catch {}; resolve(null); }, 2000);
        sock.on("connect", () => { sock.write(\`\${JSON.stringify({ type: "lookup_agent", agentName })}\\n\`); });
        sock.on("data", (d) => {
            buf += d.toString();
            for (const line of buf.split("\\n")) {
                if (!line.trim()) continue;
                try { const m = JSON.parse(line);
                    if (m.type === "agent_found" && m.sessionFile) { clearTimeout(t); try { sock.destroy(); } catch {}; resolve(m.sessionFile); return; }
                    if (m.type === "agent_not_found") { clearTimeout(t); try { sock.destroy(); } catch {}; resolve(null); return; }
                } catch {}
            }
            buf = buf.includes("\\n") ? buf.slice(buf.lastIndexOf("\\n") + 1) : buf;
        });
        sock.on("error", () => { clearTimeout(t); try { sock.destroy(); } catch {}; resolve(null); });
        sock.on("close", () => { clearTimeout(t); resolve(null); });
    });
}
`;

  const rsFn = "async function resolveSessionPath(sessionArg, cwd, sessionDir) {";
  content = content.replace(rsFn, daemonFn + "async function resolveSessionPath(sessionArg, cwd, sessionDir) {");

  // 3. Add daemon fallback before "// Not found anywhere"
  content = content.replace(
    "    // Not found anywhere",
    `    const daemonSessionFile = await resolveFromAgentIdentityDaemon(sessionArg);
    if (daemonSessionFile) return { type: "daemon", path: daemonSessionFile };
    // Not found anywhere`
  );

  // 4 & 5. Add "daemon" case in switch statements
  content = content.replace(
    `            case "path":
            case "local":
            case "global":
                return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);
            case "not_found":`,
    `            case "path":
            case "local":
            case "global":
            case "daemon":
                return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);
            case "not_found":`
  );

  content = content.replace(
    `            case "path":
            case "local":
                return SessionManager.open(resolved.path, sessionDir);

            case "global":`,
    `            case "path":
            case "local":
            case "daemon":
                return SessionManager.open(resolved.path, sessionDir);

            case "global":`
  );

  return content;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const mainJs = findPiMainJs();
if (!mainJs) { console.error("pi-agent-identity: pi main.js not found — skipping patch."); process.exit(0); }

console.error(`pi-agent-identity: Found pi main.js at ${mainJs}`);

let content;
try { content = readFileSync(mainJs, "utf-8"); } catch { console.error("pi-agent-identity: Cannot read main.js"); process.exit(0); }

if (content.includes(MARKER)) { console.error("pi-agent-identity: Already patched — skipping."); process.exit(0); }

const patched = patch(content);
if (!patched) { console.error("pi-agent-identity: Patch failed — structure changed?"); process.exit(0); }

try { writeFileSync(mainJs, patched, "utf-8"); console.error("pi-agent-identity: Patched main.js for --session <agent-name>"); }
catch { console.error("pi-agent-identity: Cannot write main.js"); process.exit(0); }
