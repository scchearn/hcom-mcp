# hcom — Examples and Patterns

## MCP-first Launch Flow

When the user asks for several agents and `hcom-mcp` is connected, do the control plane with MCP first, seed the workflow thread with `thread_seed` (pass `hub_name` explicitly in the HTTP/unbound MCP path), then switch to raw `hcom send` for communication on that shared thread:

1. `status`
2. `list_presets` and `list_topologies`
3. `launch_topology` if an exact fit exists, otherwise repeated `launch` calls
4. create one shared workflow thread with `thread_seed`, supplying `hub_name=<hub-cvcv-name>` when using the HTTP/unbound MCP path
5. explicitly tell workers to report back on-thread to the hub/current session using raw `hcom send`

## Bad Patterns (MCP Connected)

- `hcom 3 opencode ...`
- `hcom opencode --help`
- `hcom --help`
- `hcom list --names`

before checking `status`, `list_presets`, or `list_topologies`

## Bad Waiting Pattern

After workers were told to report back:

- `hcom listen 90`
- `hcom listen 120`
- repeated `hcom events --last N` polling loops

## Good Waiting Pattern

- seed the shared thread
- tell workers to report back on-thread to the hub/current session
- end your turn and wait for incoming `<hcom>` messages naturally
