# pi-agent-identity

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/elecnix/pi-agent-identity)


Gives each pi session a unique persistent identity so AI agents can collaborate across sessions via intercom.

## Architecture

- **Pi extension** (`agent-identity/index.ts`): Name generation, system prompt identity rules, daemon client, git commit co-author hook
- **Detached daemon** (`agent-identity/daemon.ts`): Singleton Unix socket server, ghost intercom sessions, disconnected session revival

## Install

```bash
pi install git:github.com/elecnix/pi-agent-identity
```

## How it works

1. Each pi session gets a random name like `swift-koala-42`
2. Sessions register with a **detached singleton daemon** via Unix socket
3. The daemon maintains **ghost intercom sessions** for disconnected agents so they remain reachable
4. **Disconnected sessions are revived**: the daemon spawns `pi --session <file> -p "message"` when an intercom message arrives for an offline agent
5. **Agent lookup**: The daemon exposes a `lookup_agent` message so pi core can resolve agent names to session files, enabling `--session <name>` (requires pi >= next release after PR [earendil-works/pi#5987](https://github.com/earendil-works/pi/pull/5987))
6. **Filesystem fallback**: If the daemon has no record of an agent (e.g. after a reboot wiped its `/tmp` registry), lookup falls back to scanning `~/.pi/agent/sessions/**/*.jsonl` for the session whose embedded `agent-identity-name` matches, and resumes the most recent one. The daemon registry is a cache; the session files are the durable source of truth. Override the scan root with `PI_SESSIONS_DIR`.
7. **Addressing by immutable identity**: the agent identity (e.g. `keen-gar-77`) is the addressable subject; the session name is mutable display metadata. On intercom `send`/`ask`, a bare identity is resolved against pi-intercom's live roster (via its extension-bus channel, ≥ 0.12) and rewritten to the registered composite name (`keen-gar-77: fix-auth-bug`) when needed — so peers stay addressable by bare name after `session_rename`. Each session also publishes `{ agentName }` on the silent `agent-identity/v1` bus namespace. If delivery still fails, the daemon relay reports honestly what happened (live delivery, revival, deferred, unresolved) and never spawns a second `pi` process against a live session file.

## Daemon protocol

| Message | Request | Response |
|---------|---------|----------|
| `lookup_agent` | `{ type: "lookup_agent", agentName: "..." }` | `{ type: "agent_found", name, sessionFile, connected, pid, active, repo }` or `{ type: "agent_not_found", agentName }` |

## Commands

| Command | Description |
|---------|-------------|
| `/whoami` | Show your agent identity |
| `/agent-status` | Daemon connection status |
| `/agent-reconnect` | Force reconnect to daemon |
| `/resume-agent` | Switch to another agent's session by name |

## Tools

| Tool | Description |
|------|-------------|
| `session_rename` | Let the agent rename its own session to reflect the task. The agent name stays as the prefix (`keen-gar-77: fix-auth-bug`). The description instructs the LLM to call it immediately on the first user message that conveys intent. |

## Name minting

Fresh names are drawn collision-free: before adopting a minted name, the extension queries the daemon's registry (`list_agents`) and re-rolls (up to 10 draws) if the name still belongs to a disconnected-but-revivable agent. This prevents a same-name remint from leaving messages stranded in a ghost intercom session (#34).
