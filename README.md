# hcom-mcp

Control-plane MCP server for launching and supervising `hcom`-managed agents.

## Why HTTP, not stdio

MCP servers typically run over stdio — the client spawns one server process per session. For a control-plane server that manages a fleet of agents, that's a problem: ten terminal sessions spawn ten isolated MCP processes with no coordination between them.

`hcom-mcp` runs as a single persistent HTTP server. Every terminal session, every MCP client, every agent talks to the same endpoint. One process, one source of truth for launches, registries, and lifecycle.

## Prerequisites

- [Node.js](https://nodejs.org) 22+
- [`hcom`](https://github.com/aannoo/hcom) CLI installed and on `PATH`

## Install

```bash
git clone https://github.com/scchearn/hcom-mcp.git
cd hcom-mcp
npm install
npm run build
```

## Run

### Foreground (any OS)

```bash
HCOM_MCP_PORT=3111 node dist/index.js
```

Listens on `http://127.0.0.1:3111/mcp`. Only localhost connections are accepted.

### As a daemon

| OS | Mechanism | Setup |
|----|-----------|-------|
| **Linux** | systemd user service | `cp docs/systemd/hcom-mcp.service ~/.config/systemd/user/ && systemctl --user enable --now hcom-mcp` |
| **macOS** | launchd | `cp docs/launchd/com.scchearn.hcom-mcp.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.scchearn.hcom-mcp.plist` |
| **Windows** | Task Scheduler or [nssm](https://nssm.cc) | See `docs/windows/hcom-mcp-task.xml` for Task Scheduler, or the nssm commands in the file comments |

Adjust the `ExecStart`/`ProgramArguments` path in the config to match where you cloned the repo.

### MCP client configuration

Point any HTTP-capable MCP client at `http://127.0.0.1:3111/mcp`. Example for Claude Desktop:

```json
{
  "mcpServers": {
    "hcom-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3111/mcp"
    }
  }
}
```

## Configuration

- `HCOM_MCP_PORT` — HTTP port (default: `3111`)
- `~/.hcom/mcp/config.json` — presets, topologies, model catalogs
- `~/.hcom/mcp/registry.json` — managed agent registry
- `.hcom-mcp.json` — optional workspace overlay (see `.hcom-mcp.example.json`)

## Skills

Install with:

```bash
npx skills add scchearn/hcom-mcp
```

Operating guidance ships in `skills/`:

- `skills/using-hcom/SKILL.md` — messaging, threads, transcripts, event watching
- `skills/hcom-agent-messaging/SKILL.md` — agent-to-agent messaging patterns and gotchas

## Tools

| Tool | Purpose |
|------|---------|
| `launch` | Launch a headless agent (preset or bare harness+model) |
| `launch_topology` | Launch multiple agents from a topology preset |
| `adopt` | Adopt an external hcom agent into managed lifecycle |
| `stop` / `kill` | Stop or kill a managed agent |
| `list_managed` | List agents managed by this server |
| `list_all` | List all live hcom agents |
| `list_models` | List available models per harness |
| `list_presets` | List configured agent presets |
| `list_topologies` | List configured topology presets |
| `inspect` | Inspect an agent's status, transcript, events, or terminal |
| `prune` | Remove stale registry records |
| `thread_seed` | Create a workflow thread |
| `thread_inspect` | Query thread events |
| `config_paths` | Show config and registry paths |
| `status` | Server health and orientation |

## License

MIT