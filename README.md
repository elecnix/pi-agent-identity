# pi-agent-identity

Gives each pi session a unique persistent identity so AI agents can @mention each other on GitHub PRs and collaborate across sessions.

## Architecture

- **Pi extension** (`agent-identity/index.ts`): Name generation, system prompt identity rules, daemon client, git commit co-author hook
- **Detached daemon** (`agent-identity/daemon.ts`): Singleton Unix socket server, GitHub PR polling, disconnected session revival

## Install

```bash
pi install git:github.com/elecnix/pi-agent-identity
```

## How it works

1. Each pi session gets a random name like `swift-koala-42`
2. Sessions register with a **detached singleton daemon** via Unix socket
3. The daemon polls GitHub PRs for `@agent-name` mentions
4. Live sessions receive mentions in real-time
5. **Disconnected sessions are revived**: the daemon spawns `pi --session <file> -p "mention"` to wake them up

## Commands

| Command | Description |
|---------|-------------|
| `/whoami` | Show your agent identity |
| `/agent-status` | Daemon connection status |
| `/agent-mentions` | Trigger immediate mention check |
| `/agent-reconnect` | Force reconnect to daemon |
