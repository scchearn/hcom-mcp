---
name: hcom
description: Use when the user wants to spawn, launch, coordinate, route, or supervise agents or workers with hcom or hcom-mcp, or when work might benefit from an agent and you need practical hub defaults, launch choices, shared-thread routing, headless worker behavior, or reliable report-back to the current session.
---

# hcom

## Overview

Use one visible hub and mostly headless workers. In OpenCode, the default hub is the current session. Do not launch another visible `hcom opencode` coordinator when the current session is already the hub. Workers may be `opencode`, `codex`, `claude`, or `gemini`, but they should usually run with `--headless` while the current session stays interactive.

Core principle: the hub owns the workflow, the thread is the source of truth, and workers only bypass the hub when the topology genuinely needs a peer handoff.

When `hcom-mcp` is available, use it for control-plane tasks such as discovery, launch, managed-fleet inspection, and cleanup. Keep raw `hcom` as the communication plane for `send`, thread seeding, peer handoff, and workflow reporting. Do not shell out to raw `hcom` for a control-plane task that already has an MCP equivalent.

**Default rule:** if prompted work might benefit from an agent, invoke this skill before deciding how to launch or coordinate one.

**Scope boundary:** This skill covers *interactive current-session coordination only*. If the user asks for a reusable script, workflow automation, `hcom run` script, or `#!/usr/bin/env bash` example, **stop and redirect them to `hcom-agent-messaging`** — do not write the script here. For installation or troubleshooting, also redirect to `hcom-agent-messaging`. For a full team topology or saved config, redirect to a planning skill such as `do-agents`.

## When to Use

- the user asks to spawn, launch, start, coordinate, or route agents or workers
- the user wants practical `hcom` operating guidance, not a full agent-team design
- the current session should remain the visible coordinator
- most workers should stay in the background
- workers may come from `opencode`, `codex`, `claude`, or `gemini`
- the user asks for a quick pattern, practical commands, or the right defaults
- workers may need to hand work directly to each other on the same thread
- you need explicit defaults for `--thread`, `--intent`, tags, and reporting
- `hcom-mcp` may be present and the agent needs a clear split between MCP bootstrap/control-plane tasks and raw `hcom` communication tasks

If the work might benefit from launching or coordinating an agent, load this skill first even when the user did not explicitly say `hcom`.

Do not use this skill for:

- `hcom` installation or troubleshooting
- reusable workflow scripts
- generating `agents/<slug>` artifacts

If the user explicitly asks for a reusable script, workflow automation, or `hcom run` script, do not write the script here. Hand that request off to `hcom-agent-messaging` and its script references.

## When `hcom-mcp` Is Available

Use MCP first for discovery, launch, and managed-fleet state. Use raw `hcom` once workers exist and the workflow is moving.

| Need | Preferred surface |
|---|---|
| discover saved launch options | `list_presets`, `list_topologies` |
| understand current state | `status`, `config_paths`, `list_all`, `list_managed` |
| inspect one managed agent | `inspect` |
| launch or clean up managed workers | `launch`, `launch_topology`, `inspect`, `stop`, `kill`, `promote` |
| assign work, seed threads, route peer handoffs, watch message flow | raw `hcom send`, `hcom events`, `hcom transcript` |

Rules:

- if `hcom-mcp` is connected, you MUST use MCP for discovery and launch before using raw `hcom` spawn commands or `hcom --help` for launch discovery
- if `hcom-mcp` exposes the operation, do not use bash plus raw `hcom` for the same control-plane task; use the MCP tool instead
- do not read `~/.hcom/mcp/config.json`, `.hcom-mcp.json`, or hunt the repo just to discover presets or topologies when `hcom-mcp` is connected
- do not treat `hcom-mcp` as the message bus; it bootstraps and supervises, but workflow communication still lives on shared hcom threads
- if no exact topology matches, stay on the MCP path: use `list_presets`, then issue repeated `launch` calls with explicit preset and harness
- only fall back to raw `hcom` CLI for control-plane work when the MCP is unavailable, the user explicitly wants shell commands only, or the MCP lacks the operation you need

## House Defaults

| Decision | Default |
|---|---|
| Visible terminal | keep the current session headed |
| Spawned workers | `--headless --go` |
| Workflow isolation | one `WF_THREAD` per task |
| Stable routing | tags like `@eng-`, `@review-`, `@research-` |
| Final reporting | on the workflow thread so the hub sees it |
| Peer handoff | allowed only when the topology needs it |
| Assignment intent | `request` |
| Routine status intent | `inform`, not `ack` |
| Discovery and launch surface | prefer `hcom-mcp` tools when available |
| Messaging command | `hcom send` |
| Waiting for worker replies | end your turn and let incoming hcom messages arrive naturally |
| Tag syntax | launch with `--tag eng`, route with `@eng-` |
| Message syntax | put all flags before `--`, then the message text |
| Spawn threading | never pass `--thread` to launch commands |

## Quick Start

Recommended order when `hcom-mcp` is connected:

1. Use `status` to orient the current workspace.
2. Use `list_presets` or `list_topologies` to discover what can be launched.
3. If a topology fits, use `launch_topology`. Otherwise use repeated `launch` calls with explicit preset and harness.
4. Seed one workflow thread with raw `hcom send` and run the collaboration there.
5. If the workers were told to report back on-thread, end your turn and wait for incoming hcom messages naturally.

## Waiting For Worker Replies

After you launch workers and seed the shared thread, the normal waiting behavior is to stop and let hcom messages arrive naturally.

Rules:

- do not use `hcom listen` to wait for ordinary worker replies after you already told them where to report back
- do not poll `hcom events --last` in a loop just to wait for results
- use `hcom events` or `hcom transcript` for message-flow inspection, and use MCP tools such as `list_all` or `inspect` for control-plane inspection; do not default to raw `hcom list` when an MCP equivalent exists
- if workers were instructed to reply on-thread to the hub/current session, end your turn and let incoming `<hcom>` messages wake the session naturally

### MCP-first example for agent-launch requests

When the user asks for several agents and `hcom-mcp` is connected, do the control plane with MCP first, then switch to raw `hcom send` for the shared thread:

1. `status`
2. `list_presets` and `list_topologies`
3. `launch_topology` if an exact fit exists, otherwise repeated `launch` calls
4. create one shared workflow thread with raw `hcom send`
5. explicitly tell workers to report back on-thread to the hub/current session

Bad pattern when MCP is connected:

- `hcom 3 opencode ...`
- `hcom opencode --help`
- `hcom --help`
- `hcom list --names`

before checking `status`, `list_presets`, or `list_topologies`

Bad waiting pattern after workers were told to report back:

- `hcom listen 90`
- `hcom listen 120`
- repeated `hcom events --last N` polling loops

Good waiting pattern:

- seed the shared thread
- tell workers to report back on-thread to the hub/current session
- end your turn and wait for incoming `<hcom>` messages naturally

```bash
WF_THREAD="repo-task-$(date +%s)"

hcom send @eng- @review- --thread "$WF_THREAD" --intent inform -- \
  "Use this thread only for the repo-task workflow. Keep updates concise. Peer handoffs are allowed only when they help the task move forward."

hcom send @eng- --thread "$WF_THREAD" --intent request -- \
  "Implement the change. Report blockers or final outcome on this thread."

hcom send @review- --thread "$WF_THREAD" --intent request -- \
  "Review the engineer's work on this thread. Send APPROVED or FIX on-thread."
```

Because the thread was seeded with the hub and both worker tags, workers can report back without hardcoding the hub name:

```bash
hcom send --thread "$WF_THREAD" --intent inform -- "DONE: implemented and tested"
```

From the hub, inspect the thread if needed instead of spawning another visible coordinator. Prefer MCP `list_all` for live-agent discovery when available, and do not turn this into a polling loop when workers were already told to report back naturally:

```bash
hcom events --sql "msg_thread='${WF_THREAD}'" --last 20
```

Use peer-to-peer handoff only when needed, and keep it on the same thread:

```bash
hcom send @review- --thread "$WF_THREAD" --intent request -- \
  "Review the latest engineer result on this thread and reply with APPROVED or FIX."
```

Important syntax rules:

- launch tags are plain names such as `--tag eng` or `--tag review`
- routed sends use the real hcom group form `@<tag>-`, such as `@eng-` or `@review-`
- use only valid intents: `request`, `inform`, `ack`
- put `--` before the message text in every `hcom send` command

## Cross-Tool Launch Patterns

Use this section only when `hcom-mcp` is unavailable, the user explicitly wants shell-only launch commands, or the MCP lacks the operation you need.

```bash
hcom 1 opencode --tag exec --go --headless
hcom 1 codex --tag eng --go --headless
hcom 1 claude --tag review --go --headless
hcom 1 gemini --tag research --go --headless
```

For OpenCode worker model selection, prefer provider-qualified IDs:

```bash
HCOM_OPENCODE_ARGS="--model openai/gpt-5.4" hcom 1 opencode --tag exec --go --headless
```

## Worker Prompt Contract

When you tell a worker what to do, include these defaults:

- stay on the assigned thread
- keep updates minimal
- use `request` for assignments, handoffs that need action, and blockers that need a decision
- use `inform` for status and final outcomes
- reserve `ack` for explicit acknowledgments tied to a request or reply context
- report blockers and final outcomes on-thread
- hand work directly to another tagged role only when the topology requires it
- stop when the assignment is complete if the task is one-shot

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
| making workers report to a special hub alias every time | seed the thread once, then let workers report on-thread |
| omitting `--` before the message text in `hcom send` | put every flag before `--`, then the message body |
| inventing intent names like `assign` | use only `request`, `inform`, and `ack` |
| using `ack` as generic low-noise status | use `inform` for routine updates; keep `ack` for explicit acknowledgments |
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
| "Workers need a hardcoded hub name to report back" | Seed the thread with `@mentions`, then workers can send on-thread. |
| "I can invent an intent like `assign` because it reads better" | Only `request`, `inform`, and `ack` are valid hcom intents. |
| "`ack` is the best default for quiet status updates" | Use `inform` for routine status; use `ack` only for explicit acknowledgments. |
| "Every update has to come back through me" | Let workers hand off directly when the topology needs it, but keep the thread shared. |
| "This question needs a script or a team-plan artifact" | Stay in operating-guidance scope unless the user explicitly asks for automation or design artifacts. |
| "I should read config files or search the repo to discover presets/topologies" | If `hcom-mcp` is connected, use `list_presets`, `list_topologies`, `status`, or `config_paths` instead of filesystem discovery. |
| "Because this is an hcom question, all launch/discovery should be raw CLI" | Use `hcom-mcp` for the control plane when available; use raw `hcom` for the communication plane. |

## Red Flags

- more than one visible terminal by default
- launching `hcom opencode` from an already-visible OpenCode session just to create another hub
- no workflow thread
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

## If The User Needs More

- use `hcom-agent-messaging` for installation, troubleshooting, or script details
- use a dedicated planning skill such as `do-agents` when the user wants a topology decision, agent roster, or saved config
- run `hcom --help`, `hcom send --help`, or `hcom opencode --help` when exact flag syntax matters

## Hard Boundaries

- do not write reusable `hcom` scripts in this skill
- do not answer script-authoring requests with `#!/usr/bin/env bash` or `hcom run` examples here
- for script requests, point to `hcom-agent-messaging` and its script template/reference material instead

If the user asks for a reusable script, workflow automation, or `hcom run` script, respond with a short redirect:

> That is reusable workflow-script scope, not current-session coordination scope. Use **hcom-agent-messaging** for script authoring and the hcom script template/reference docs.
