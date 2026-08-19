import { z } from "zod";
import {
  canonicalizeAgentName,
  execHcom,
  findLiveAgentByIdentifier,
  listHcomAgents,
  parseHcomJson,
  resolveCallerName,
} from "../hcom.js";
import { getOwnedRecordsByWorkspace } from "../registry.js";
import type { HcomAgent, RegistryRecord } from "../types.js";
import { E_INTERNAL, E_NO_SENDER, internalError, toolError } from "../errors.js";

const WatchModeEnum = z.enum(["poll", "subscribe"]);

interface LifeEvent {
  action?: string;
  status?: string;
  ts?: string;
}

interface MessageEvent {
  from?: string;
  text?: string;
  ts?: string;
}

/**
 * Parse NDJSON event lines (hcom events emits one JSON object per line).
 * Returns [] for non-JSON output so a CLI format drift degrades to "no
 * events" instead of a hard error.
 */
function parseEventLines<T>(stdout: string): T[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseHcomJson<T>(line))
    .filter((e): e is T => e !== null);
}

/**
 * Fetch recent life events for one agent. One CLI call per agent; the
 * per-agent filter keeps the payload small and the join honest.
 */
async function fetchLifeEvents(name: string): Promise<LifeEvent[]> {
  const result = await execHcom(["events", "--last", "20", "--type", "life", "--agent", name]);
  if (result.exitCode !== 0) return [];
  return parseEventLines<LifeEvent>(result.stdout);
}

/**
 * Fetch the most recent message sent BY the agent (its last report to the
 * hub). Returns undefined when there is no message event in the window.
 */
async function fetchLastMessage(name: string): Promise<MessageEvent | undefined> {
  const result = await execHcom(["events", "--last", "50", "--type", "message", "--agent", name]);
  if (result.exitCode !== 0) return undefined;
  const events = parseEventLines<MessageEvent>(result.stdout);
  return events[0];
}

/**
 * Build the per-agent watch line for poll mode.
 *
 * Flags (reporting only — never auto-kill):
 * - blocked: live status == blocked (needs human/rescue)
 * - silent_finisher: listening + age > report_timeout + no message since the
 *   last dispatch (finished or died quietly; nobody told)
 * - stalled: active + age > report_timeout (maybe wedged tool call)
 * - lost: record present, live agent gone
 * - unreported: hub has unconsumed messages from this agent
 */
export async function buildWatchLine(
  record: RegistryRecord,
  liveAgents: HcomAgent[],
  reportTimeoutSec: number,
): Promise<{
  name: string;
  status: string | null;
  statusAgeSeconds: number | null;
  unreadCount: number | null;
  flags: string[];
  lastLifeEvent: string | null;
  lastMessage: string | null;
}> {
  const live = findLiveAgentByIdentifier(record.hcomName ?? "", liveAgents);
  const flags: string[] = [];

  if (!live) {
    flags.push("lost");
    return {
      name: record.hcomName ?? record.id,
      status: null,
      statusAgeSeconds: null,
      unreadCount: null,
      flags,
      lastLifeEvent: null,
      lastMessage: null,
    };
  }

  const age = live.status_age_seconds ?? 0;
  const unread = live.unread_count ?? 0;

  const lastMessage = await fetchLastMessage(live.base_name);

  if (live.status === "blocked") {
    flags.push("blocked");
  } else if (live.status === "listening" && age > reportTimeoutSec && lastMessage) {
    // Silent finisher: the agent reported at least once but has been quiet
    // (listening) for longer than the report timeout. No report at all means
    // plain idle, not a finisher.
    flags.push("silent_finisher");
  } else if (live.status === "active" && age > reportTimeoutSec) {
    flags.push("stalled");
  }

  if (unread > 0) {
    flags.push("unreported");
  }

  const lifeEvents = await fetchLifeEvents(live.base_name);
  const lastLife = lifeEvents[0]?.action ?? lifeEvents[0]?.status ?? null;

  const lastMessageText = lastMessage
    ? `${lastMessage.from ?? "?"}: ${(lastMessage.text ?? "").slice(0, 80)}`
    : null;

  return {
    name: live.name,
    status: live.status,
    statusAgeSeconds: age,
    unreadCount: unread,
    flags,
    lastLifeEvent: lastLife,
    lastMessage: lastMessageText,
  };
}

/**
 * Register the watch_agents tool: hub-side supervision between spawn and
 * kill. Poll mode returns a summarized snapshot (one line per agent, not
 * transcripts) with derived flags; subscribe mode installs hcom event
 * subscriptions that wake the hub via hcom message. Reporting only — never
 * auto-kills.
 */
export function registerWatchAgentsTool(server: any) {
  server.tool(
    "watch_agents",
    "Supervise owned agents between spawn and kill. Poll mode returns a summarized snapshot (one line per agent) with derived flags: blocked (needs human), silent_finisher (listening past report_timeout with no dispatch), stalled (active past report_timeout), lost (record present, live gone), unreported (unconsumed messages). Subscribe mode installs hcom event subscriptions that wake the hub via hcom message. Reporting only — never auto-kills. Poll returns { mode, agents, summary }; subscribe returns { mode, caller, subscriptions, total, note }. Preconditions: subscribe mode requires sender identity (see sender_name). Related: unblock (rescue blocked), stop/kill (act on flags).",
    {
      names: z.array(z.string()).optional().describe("Agent names to watch. Omit to watch all owned records in the workspace."),
      tag: z.string().optional().describe("Watch only records whose live agent carries this tag."),
      workspace: z.string().optional().describe("Workspace path for ownership resolution. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      mode: WatchModeEnum.optional().describe("poll: sync snapshot (default). subscribe: install hcom event subscriptions and return their ids."),
      report_timeout_sec: z.number().int().positive().default(300).describe("Seconds of quiet before an agent is flagged silent_finisher or stalled (default: 300)."),
      sender_name: z.string().optional().describe("Sender identity for subscribe mode. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
    },
    async ({ names, tag, workspace, mode, report_timeout_sec, sender_name }: {
      names?: string[];
      tag?: string;
      workspace?: string;
      mode?: "poll" | "subscribe";
      report_timeout_sec?: number;
      sender_name?: string;
    }) => {
      const cwd = workspace ?? process.cwd();
      const timeoutSec = report_timeout_sec ?? 300;

      try {
        const records = getOwnedRecordsByWorkspace(cwd);
        const liveAgents = await listHcomAgents();

        // Scope: explicit names (canonicalized) or tag, else all owned records.
        let scoped = records;
        if (names && names.length > 0) {
          const canonical = names.map((n) => canonicalizeAgentName(n, liveAgents));
          scoped = records.filter((r) => r.hcomName && canonical.includes(r.hcomName));
        } else if (tag) {
          const tagged = new Set(
            liveAgents.filter((a) => a.tag === tag).map((a) => a.base_name),
          );
          scoped = records.filter((r) => r.hcomName && tagged.has(r.hcomName));
        }

        if (mode === "subscribe") {
          const caller = await resolveCallerName(sender_name);
          if (!caller) {
            return toolError(
              E_NO_SENDER,
              "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
            );
          }

          const subscriptions: { agent: string; subId: string | null; kind: string; error?: string }[] = [];
          for (const record of scoped) {
            const name = record.hcomName;
            if (!name) continue;
            for (const kind of ["life", "blocked"] as const) {
              const args =
                kind === "life"
                  ? ["events", "sub", "--for", caller, "--agent", name, "--type", "life"]
                  : ["events", "sub", "--for", caller, "--status", "blocked", "--agent", name];
              const result = await execHcom(args);
              const subId = result.stdout.match(/sub-[a-f0-9]+/)?.[0] ?? null;
              subscriptions.push({
                agent: name,
                kind,
                subId,
                ...(result.exitCode !== 0 ? { error: result.stderr || result.stdout } : {}),
              });
            }
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  mode: "subscribe",
                  caller,
                  subscriptions,
                  total: subscriptions.length,
                  note: "The hub is woken by hcom message on matching events. Remove with hcom events unsub <id>.",
                },
                null,
                2,
              ),
            }],
          };
        }

        // Poll mode: one line per agent, summarized. Sequential loop, not
        // Promise.all: each line spawns up to 2 hcom events subprocesses, and
        // an unbounded fan-out over a large fleet would saturate the CLI.
        const lines: Awaited<ReturnType<typeof buildWatchLine>>[] = [];
        for (const record of scoped) {
          lines.push(await buildWatchLine(record, liveAgents, timeoutSec));
        }

        const summary = {
          total: lines.length,
          blocked: lines.filter((l) => l.flags.includes("blocked")).length,
          silent_finisher: lines.filter((l) => l.flags.includes("silent_finisher")).length,
          stalled: lines.filter((l) => l.flags.includes("stalled")).length,
          lost: lines.filter((l) => l.flags.includes("lost")).length,
          unreported: lines.filter((l) => l.flags.includes("unreported")).length,
          healthy: lines.filter((l) => l.flags.length === 0).length,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ mode: "poll", agents: lines, summary }, null, 2),
          }],
        };
      } catch (err: any) {
        return internalError(err);
      }
    },
  );
}
