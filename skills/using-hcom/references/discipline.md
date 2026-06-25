# hcom — Discipline Enforcement

Common mistakes, rationalization counters, and red flags for hcom coordination.

## Common Mistakes

| Mistake | Fix |
|---|---|
| work might benefit from agents but the skill was never invoked | invoke this skill first whenever the prompt suggests spawning, launching, coordinating, or supervising workers |
| `hcom-mcp` is connected but raw `hcom` launch commands are used first | use `status`, `list_presets`, `list_topologies`, `launch`, or `launch_topology` first |
| `hcom-mcp` is connected but `hcom list`, `hcom status`, or other raw control-plane commands are used anyway | use the MCP equivalent such as `list_all`, `status`, `list_managed`, or `inspect`; reserve raw `hcom` for messaging, threads, or explicit shell-only requests |
| using `hcom listen` to wait for normal worker replies | if workers were told where to report back, end your turn and let incoming hcom messages arrive naturally |
| repeatedly polling `hcom events --last` after seeding the shared thread | inspect once if needed, otherwise stop and wait for natural report-back |
| launching extra visible terminals by default | keep the current session visible and spawn workers with `--headless --go` |
| launching `hcom opencode` again even though the current OpenCode session is already the hub | keep the current session as coordinator and only spawn the workers you need |
| inventing tag syntax like `--tag @eng-foo` or routing with `@eng-foo` by default | launch with `--tag eng`; route to the group with `@eng-` |
| routing by fragile generated names | use tags for role routing; use exact names only for a specific known instance |
| making workers report to a special hub alias every time | seed the thread with `@<hub-name>`, then workers `@<hub-name>` on important replies |
| seeding a thread without including the hub as a @mention | include `@<hub-name>` in the seed message so the hub receives thread messages |
| seeding a thread with raw `hcom send` when `thread_seed` is available | use `thread_seed` to include the exact hub mention in the seed; in HTTP/unbound callers, pass `hub_name` explicitly |
| assuming broadcast on a thread reaches the hub when the hub was only the sender | the sender is never in `delivered_to`; the hub must be @mentioned on the seed to become a thread member |
| omitting `--` before the message text in `hcom send` | put every flag before `--`, then the message body |
| inventing intent names like `assign` | use only `request`, `inform`, and `ack` |
| using `ack` as generic low-noise status | use `inform` for routine updates; keep `ack` for explicit acknowledgments |
| sending `ack` in reply to an `inform` message | do not ack informational messages; either send no reply or send a separate `inform` only when a useful status update is needed |
| putting `--thread` on `hcom opencode` or other spawn commands | put `--thread` on `hcom send` and `hcom events`, not on spawn commands; do not use `hcom listen` for normal worker replies |
| escalating every handoff back through the hub | allow peer handoffs on the same thread when review or specialization needs it |
| answering with generic `hcom` commands but no routing defaults | state the hub, headless-worker, thread, and report-flow defaults explicitly |
| reading config files or using globs to discover saved presets/topologies while `hcom-mcp` is connected | use `list_presets`, `list_topologies`, `status`, and `config_paths` first |
| using raw launch commands when the real need is a managed preset/topology launch | prefer `launch` or `launch_topology`, then switch to raw `hcom send` for coordination |

## Rationalizations To Reject

| Excuse | Counter-rule |
|---|---|
| "This prompt just mentions agents, not hcom" | If the work might benefit from spawning or coordinating agents, invoke this skill first. |
| "I should inspect `hcom --help` before I decide anything" | If `hcom-mcp` is connected, use MCP discovery tools first. |
| "Running `hcom list` in bash is fine even though `list_all` exists" | No. If MCP exposes the control-plane operation, use MCP instead of a redundant shell-out. |
| "I should use `hcom listen` so I don't miss worker replies" | If workers were told to report back, end your turn; replies should arrive naturally. |
| "I need to keep checking the thread while they work" | Use one shared thread and stop. Inspect only when diagnosing delivery problems or when the user explicitly wants monitoring. |
| "Generic launch commands are enough" | State the house defaults explicitly: current session stays headed, workers are headless. |
| "Because the user mentioned OpenCode, I should tell them to run `hcom opencode` again" | If the current OpenCode session is already interactive, it is the hub. Spawn workers, not a second visible coordinator. |
| "I can route with made-up names like `@eng-codex` or put `@` in the launch tag" | Launch with plain `--tag eng`; route the role group with `@eng-`. |
| "I should name every worker directly" | Prefer tags for stable role routing; direct names are for one exact instance. |
| "Workers need a hardcoded hub name to report back" | Seed the thread with `@<hub-name>` (your CVCV name from the hcom system context), then workers use that name on important replies. |
| "The hub created the thread so it's automatically a member" | No. Senders are excluded from `delivered_to`. The hub must @mention itself on the seed to become a thread member. |
| "I can invent an intent like `assign` because it reads better" | Only `request`, `inform`, and `ack` are valid hcom intents. |
| "`ack` is the best default for quiet status updates" | Use `inform` for routine status; use `ack` only for explicit acknowledgments. |
| "I should ack this inform so they know I saw it" | No. Informational messages do not need acknowledgment; send nothing unless a separate `inform` update is actually useful. |
| "Every update has to come back through me" | Let workers hand off directly when the topology needs it, but keep the thread shared. |
| "This question needs a script or a team-plan artifact" | Stay in operating-guidance scope unless the user explicitly asks for automation or design artifacts. |
| "I should read config files or search the repo to discover presets/topologies" | If `hcom-mcp` is connected, use `list_presets`, `list_topologies`, `status`, or `config_paths` instead of filesystem discovery. |
| "Because this is an hcom question, all launch/discovery should be raw CLI" | Use `hcom-mcp` for the control plane when available; use raw `hcom` for the communication plane. |

## Red Flags

- more than one visible terminal by default
- launching `hcom opencode` from an already-visible OpenCode session just to create another hub
- no workflow thread
- thread seed that does not include `@<hub-name>` (the hub's CVCV name) as a @mention
- `--thread` on a spawn command
- role routing without tags
- worker reports that depend on a fragile generated name
- filesystem exploration for preset/topology discovery even though `hcom-mcp` is available
- raw `hcom` launch discovery or spawn commands before MCP discovery in an MCP-connected workspace
- raw `hcom` control-plane shell-outs such as `hcom list` when `list_all` or another MCP equivalent exists
- using `hcom listen` while waiting for normal worker reports
- repeated `hcom events --last` polling after workers were already told where to reply
- trying to turn `hcom-mcp` into a generic message bus instead of using raw hcom threads
- turning a usage question into installation support, script authoring, or full team design
