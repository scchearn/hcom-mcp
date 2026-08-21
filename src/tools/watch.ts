import { z } from "zod";
import {
  canonicalizeAgentName,
  execHcom,
  findLiveAgentByIdentifier,
  listHcomAgents,
  parseHcomJson,
  resolveCallerName,
} from "../hcom.js";
import { getOwnedRecordsByWorkspace, resolveRootLauncher } from "../registry.js";
import { installSubscription } from "../supervision.js";
import type { HcomAgent, RegistryRecord } from "../types.js";
import { E_INTERNAL, E_NO_SENDER, internalError, toolError } from "../errors.js";
import {
  eventData,
  eventTimeMs,
  eventTimestamp,
  isAgentMessageEvent,
  isInboundDispatchEvent,
  messageFields,
  newestEvent,
  parseHcomEvents,
  type HcomEvent,
} from "../events.js";

const WatchModeEnum = z.enum(["poll", "subscribe"]);
const WEDGED_QUEUE_THRESHOLD_SEC = 600;

interface WedgedQueueEvidence {
  evidenceTimestamp: string;
  ageSeconds: number;
  dispatchIntent: string | null;
  termTail: string;
}

interface ReportEvidence {
  required: boolean;
  dispatchAt: string | null;
  latestDispatchAt: string | null;
  latestDispatchIntent: string | null;
  reportReceived: boolean | null;
  reportAt: string | null;
}

/**
 * Parse NDJSON event lines (hcom events emits one JSON object per line).
 * Returns [] for non-JSON output so a CLI format drift degrades to "no
 * events" instead of a hard error.
 */
async function fetchAgentEvents(name: string): Promise<HcomEvent[]> {
  const [life, message] = await Promise.all([
    execHcom(["events", "--last", "200", "--type", "life", "--agent", name]),
    execHcom(["events", "--last", "200", "--type", "message", "--agent", name]),
  ]);
  return [life, message]
    .filter((result) => result.exitCode === 0)
    .flatMap((result) => parseHcomEvents(result.stdout));
}

async function fetchInboundEvents(name: string): Promise<HcomEvent[]> {
  const result = await execHcom(["events", "--last", "200", "--type", "message", "--mention", name]);
  if (result.exitCode !== 0) return [];
  return parseHcomEvents(result.stdout);
}

function isAgentConsumptionEvent(event: HcomEvent, agentName: string, dispatchMs: number): boolean {
  const timestamp = eventTimeMs(event);
  if (timestamp === null || timestamp <= dispatchMs) return false;
  const data = eventData(event);

  if (event.type === "message") {
    return isAgentMessageEvent(event, agentName);
  }
  if (event.type !== "status") return false;
  if (event.instance && event.instance !== agentName) return false;
  return (
    data.status === "active" ||
    data.new_status === "active" ||
    (typeof data.context === "string" && data.context.startsWith("tool:")) ||
    (typeof data.new_context === "string" && data.new_context.startsWith("tool:"))
  );
}

async function fetchTermTail(name: string): Promise<string> {
  const result = await execHcom(["term", name, "--json"]);
  if (result.exitCode !== 0) return `(hcom term failed: ${result.stderr || result.stdout})`;
  const parsed = parseHcomJson<{ lines?: unknown }>(result.stdout);
  if (parsed && Array.isArray(parsed.lines)) {
    return parsed.lines.filter((line): line is string => typeof line === "string").slice(-30).join("\n");
  }
  return result.stdout.slice(-4000);
}

async function detectWedgedQueue(
  live: HcomAgent,
  agentEvents: HcomEvent[],
  inboundEvents: HcomEvent[],
): Promise<WedgedQueueEvidence | undefined> {
  if (live.tool !== "opencode" || live.status !== "listening") return undefined;

  const dispatches = inboundEvents
    .filter((event) => isInboundDispatchEvent(event, live.base_name))
    .map((event) => ({ event, timestamp: eventTimeMs(event) }))
    .filter((entry): entry is { event: HcomEvent; timestamp: number } => entry.timestamp !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
  const latestDispatch = dispatches[0];
  if (!latestDispatch) return undefined;

  if (agentEvents.some((event) => isAgentConsumptionEvent(event, live.base_name, latestDispatch.timestamp))) {
    return undefined;
  }

  const ageSeconds = Math.floor((Date.now() - latestDispatch.timestamp) / 1000);
  if (ageSeconds < WEDGED_QUEUE_THRESHOLD_SEC) return undefined;

  return {
    evidenceTimestamp: eventTimestamp(latestDispatch.event) ?? new Date(latestDispatch.timestamp).toISOString(),
    ageSeconds,
    dispatchIntent: messageFields(latestDispatch.event).intent ?? null,
    termTail: await fetchTermTail(live.base_name),
  };
}

function buildReportEvidence(
  record: RegistryRecord,
  agentEvents: HcomEvent[],
  inboundEvents: HcomEvent[],
): ReportEvidence {
  const baseline = record.dispatchAt ?? record.createdAt ?? null;
  const baselineMs = eventTimeMs(baseline ?? undefined);
  const latestDispatch = newestEvent(
    inboundEvents.filter((event) => isInboundDispatchEvent(event, record.hcomName ?? "")),
  );
  const latestDispatchMs = latestDispatch ? eventTimeMs(latestDispatch) : null;
  const effectiveDispatchMs = [baselineMs, latestDispatchMs]
    .filter((value): value is number => value !== null)
    .reduce((latest, value) => Math.max(latest, value), 0);
  const report = record.requireReport
    ? newestEvent(
        agentEvents.filter(
          (event) => {
            const timestamp = eventTimeMs(event);
            return effectiveDispatchMs > 0 && timestamp !== null && timestamp >= effectiveDispatchMs && isAgentMessageEvent(event, record.hcomName ?? "");
          },
        ),
      )
    : undefined;

  return {
    required: record.requireReport ?? false,
    dispatchAt: baseline,
    latestDispatchAt: latestDispatch ? eventTimestamp(latestDispatch) ?? null : null,
    latestDispatchIntent: latestDispatch ? messageFields(latestDispatch).intent ?? null : null,
    reportReceived: record.requireReport ? Boolean(report) : null,
    reportAt: report ? eventTimestamp(report) ?? null : null,
  };
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
  options: { caller?: string; records?: RegistryRecord[] } = {},
): Promise<{
  name: string;
  status: string | null;
  statusAgeSeconds: number | null;
  unreadCount: number | null;
  flags: string[];
  lastLifeEvent: string | null;
  lastMessage: string | null;
  report: ReportEvidence;
  wedgedQueue?: WedgedQueueEvidence;
  // Provenance (#33 follow-up): whose lane this agent belongs to. foreign
  // is true when the launcher is not the calling hub — surfaced as a field,
  // never silently mixed.
  launchedBy: string | null;
  rootLaunchedBy: string | null;
  foreign: boolean;
}> {
  const live = findLiveAgentByIdentifier(record.hcomName ?? "", liveAgents);
  const flags: string[] = [];
  const rootLaunchedBy = resolveRootLauncher(record, options.records ?? [record]) ?? record.launchedBy ?? null;
  const foreign = Boolean(options.caller && record.launchedBy && record.launchedBy !== options.caller);

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
      report: buildReportEvidence(record, [], []),
      launchedBy: record.launchedBy ?? null,
      rootLaunchedBy,
      foreign,
    };
  }

  const age = live.status_age_seconds ?? 0;
  const unread = live.unread_count ?? 0;

  const agentEvents = await fetchAgentEvents(live.base_name);
  const inboundEvents = live.tool === "opencode" || record.requireReport
    ? await fetchInboundEvents(live.base_name)
    : [];
  const lastMessage = newestEvent(
    agentEvents.filter((event) => isAgentMessageEvent(event, live.base_name)),
  );

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

  const life = newestEvent(
    agentEvents.filter((event) => event.type === "life" || (event.type === undefined && "action" in eventData(event))),
  );
  const lastLife = String(eventData(life ?? {}).action ?? eventData(life ?? {}).status ?? "") || null;

  const wedgedQueue = await detectWedgedQueue(live, agentEvents, inboundEvents);
  if (wedgedQueue) flags.push("wedged_queue");

  const report = buildReportEvidence(record, agentEvents, inboundEvents);

  const lastMessageText = lastMessage
    ? `${messageFields(lastMessage).from ?? "?"}: ${(messageFields(lastMessage).text ?? "").slice(0, 80)}`
    : null;

  return {
    name: live.name,
    status: live.status,
    statusAgeSeconds: age,
    unreadCount: unread,
    flags,
    lastLifeEvent: lastLife,
    lastMessage: lastMessageText,
    report,
    launchedBy: record.launchedBy ?? null,
    rootLaunchedBy,
    foreign,
    ...(wedgedQueue ? { wedgedQueue } : {}),
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
    "Supervise owned agents between spawn and kill. Poll mode returns a one-line-per-agent snapshot with derived flags: blocked (needs human), silent_finisher (listening past report_timeout with no dispatch), stalled (active past report_timeout), lost (record present, live gone), unreported (unconsumed messages), wedged_queue (OpenCode listening with an unresolved inbound non-ack message and no consumption evidence for >=600s), plus report-gate/dispatch/report evidence per line. Subscribe mode installs hcom event subscriptions that wake the hub via message. Reporting only — never auto-kills or auto-rescues. Preconditions: subscribe requires sender identity (see sender_name). Related: unblock (rescue blocked), stop/kill (act on flags).",
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
        // Resolved for both modes: subscribe requires it; poll uses it to
        // flag lines whose launcher is not the calling hub. Unbound callers
        // get undefined, which simply disables foreign flagging.
        const caller = await resolveCallerName(sender_name);

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
              try {
                // Shared installer with the supervision lane (#33): one arg
                // builder, one stdout sub-id parse.
                const sub = await installSubscription(caller, name, kind, execHcom);
                subscriptions.push({ agent: name, kind, subId: sub.subId });
              } catch (err: any) {
                subscriptions.push({
                  agent: name,
                  kind,
                  subId: null,
                  ...(err?.message ? { error: String(err.message) } : {}),
                });
              }
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
        // Promise.all: each line spawns up to 3 hcom events subprocesses, and
        // an unbounded fan-out over a large fleet would saturate the CLI.
        const lines: Awaited<ReturnType<typeof buildWatchLine>>[] = [];
        for (const record of scoped) {
          lines.push(await buildWatchLine(record, liveAgents, timeoutSec, { caller, records }));
        }

        const summary = {
          total: lines.length,
          blocked: lines.filter((l) => l.flags.includes("blocked")).length,
          silent_finisher: lines.filter((l) => l.flags.includes("silent_finisher")).length,
          stalled: lines.filter((l) => l.flags.includes("stalled")).length,
          wedged_queue: lines.filter((l) => l.flags.includes("wedged_queue")).length,
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
