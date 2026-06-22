# pi-agent-identity

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
5. **Agent lookup**: The daemon exposes a `lookup_agent` message so pi core can resolve agent names to session files, enabling `--session <name>`

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
