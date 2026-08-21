import { execHcom } from "./hcom.js";
import type { ExecHcomFn } from "./supervision.js";
import { defaultSupervisionPolicy } from "./supervision.js";
import {
  eventData,
  eventTimeMs,
  isAgentMessageEvent,
  isInboundDispatchEvent,
  newestEvent,
  type HcomEvent,
} from "./events.js";
import {
  detectWedgedQueue,
  fetchAgentEvents,
  fetchInboundEvents,
} from "./tools/watch.js";
import {
  applySupervisionUpdates,
  reconcileGlobalRecords,
} from "./registry.js";
import { detectAndAdoptDescendants } from "./descendants.js";
import type {
  HcomAgent,
  RegistryRecord,
  SupervisionIncidentType,
  SupervisionState,
} from "./types.js";

// --- Evidence (harness adapters) ---

export interface WorkerEvidence {
  liveAgent: HcomAgent | null;
  // Latest meaningful activity per the generic contract: agent-originated
  // message/report, lifecycle progress (ready/started), transition into
  // active work, tool/command/file activity. `listening` is deliberately
  // NOT activity — it must not reset the silence timer while work or a
  // required report is outstanding.
  lastActivityAtMs: number | null;
  lastActivityKind: string | null;
  outstandingDispatch: boolean;
  wedgedQueue: boolean;
}

/**
 * Generic meaningful-activity adapter. OpenCode adds queued/wedge evidence
 * through detectWedgedQueue (classification input, never an activity reset);
 * Claude and Codex use these same lifecycle/message signals.
 */
export function latestMeaningfulActivity(
  agentName: string,
  agentEvents: HcomEvent[],
): { atMs: number; kind: string } | null {
  let best: { atMs: number; kind: string } | null = null;
  for (const event of agentEvents) {
    let kind: string | null = null;
    if (isAgentMessageEvent(event, agentName)) {
      kind = "report";
    } else if (event.type === "life" || (event.type === undefined && "action" in eventData(event))) {
      const action = String(eventData(event).action ?? "");
      if (action === "ready" || action === "started") kind = `lifecycle:${action}`;
    } else if (event.type === "status") {
      const data = eventData(event);
      const status = String(data.status ?? data.new_status ?? "");
      const context = String(data.context ?? data.new_context ?? "");
      if (context.startsWith("tool:")) kind = `work:${context.slice(5)}`;
      else if (status === "active") kind = "work";
    }
    if (!kind) continue;
    const atMs = eventTimeMs(event);
    if (atMs === null) continue;
    if (!best || atMs > best.atMs) best = { atMs, kind };
  }
  return best;
}

/**
 * True when the worker still owes the hub work: unconsumed messages, an
 * unmet require_report promise, or a dispatch with no consumption evidence
 * after it.
 */
export function hasOutstandingDispatch(params: {
  record: Pick<RegistryRecord, "hcomName" | "requireReport" | "dispatchAt" | "createdAt">;
  liveAgent: HcomAgent | null;
  agentEvents: HcomEvent[];
  inboundEvents: HcomEvent[];
}): boolean {
  const name = params.record.hcomName ?? "";
  if ((params.liveAgent?.unread_count ?? 0) > 0) return true;

  const baselineMs = eventTimeMs(params.record.dispatchAt ?? params.record.createdAt);
  const dispatches = params.inboundEvents
    .filter((event) => isInboundDispatchEvent(event, name))
    .map((event) => eventTimeMs(event))
    .filter((value): value is number => value !== null);
  const effectiveDispatchMs = Math.max(baselineMs ?? 0, ...dispatches);

  if (params.record.requireReport && effectiveDispatchMs > 0) {
    const report = newestEvent(
      params.agentEvents.filter((event) => {
        const atMs = eventTimeMs(event);
        return isAgentMessageEvent(event, name) && atMs !== null && atMs >= effectiveDispatchMs;
      }),
    );
    if (!report) return true;
  }

  // A dispatch newer than the last consumption evidence is still queued.
  const latestDispatchMs = dispatches.length > 0 ? Math.max(...dispatches) : null;
  if (latestDispatchMs !== null) {
    const consumed = params.agentEvents.some((event) => {
      const atMs = eventTimeMs(event);
      if (atMs === null || atMs <= latestDispatchMs) return false;
      return (
        isAgentMessageEvent(event, name) ||
        String(eventData(event).status ?? eventData(event).new_status ?? "") === "active" ||
        String(eventData(event).context ?? eventData(event).new_context ?? "").startsWith("tool:")
      );
    });
    if (!consumed) return true;
  }

  return false;
}

function findLive(name: string, agents: HcomAgent[]): HcomAgent | null {
  return agents.find((a) => a.name === name || a.base_name === name) ?? null;
}

/** Default evidence fetcher: live status + hcom event stream. */
export async function fetchWorkerEvidence(
  record: RegistryRecord,
  liveAgents: HcomAgent[],
  nowMs: number,
  execHcomFn: ExecHcomFn = execHcom,
): Promise<WorkerEvidence> {
  const name = record.hcomName ?? "";
  const liveAgent = name ? findLive(name, liveAgents) : null;
  if (!liveAgent) {
    return {
      liveAgent: null,
      lastActivityAtMs: null,
      lastActivityKind: null,
      outstandingDispatch: false,
      wedgedQueue: false,
    };
  }
  const [agentEvents, inboundEvents] = await Promise.all([
    fetchAgentEvents(liveAgent.base_name, execHcomFn),
    fetchInboundEvents(liveAgent.base_name, execHcomFn),
  ]);
  const activity = latestMeaningfulActivity(liveAgent.base_name, agentEvents);
  const wedged = await detectWedgedQueue(liveAgent, agentEvents, inboundEvents, nowMs);
  return {
    liveAgent,
    lastActivityAtMs: activity?.atMs ?? null,
    lastActivityKind: activity?.kind ?? null,
    outstandingDispatch: hasOutstandingDispatch({ record, liveAgent, agentEvents, inboundEvents }),
    wedgedQueue: Boolean(wedged),
  };
}

// --- Sweep-side supervision resolution ---

/**
 * Resolve the supervision state a sweep evaluates a record under. Records
 * carrying an explicit block use it as-is; managed headless records WITHOUT
 * one are supervised at resolved defaults (covers resume/fork/legacy and
 * any future launch path that forgets to wire supervision — defaulting
 * closed instead of leaving permanent holes). Released, adopted, and
 * headed records are not supervised. An empty hub means classification and
 * retention still happen but delivery cannot (missing-hub retention path).
 */
export function resolveRecordSupervision(record: RegistryRecord): SupervisionState | null {
  if (record.released) return null;
  if (record.state.startsWith("adopted_")) return null;
  if (record.launchMode === "headed") return null;
  if (record.supervision) return record.supervision;
  const baselineAt = record.dispatchAt ?? record.createdAt;
  if (!baselineAt) return null;
  return {
    hub: record.launchedBy ?? "",
    policy: defaultSupervisionPolicy(),
    subscriptions: [],
    baselineAt,
  };
}

// --- Incident decision (pure, controllable clock) ---

export interface SweepOutcome {
  supervision: SupervisionState;
  notify?: { level: "attention" | "escalation"; text: string };
  // Routine lifecycle inform (#33): recovered-after-incident and
  // completed-stopped-cleanly. `inform` intent, once per transition.
  inform?: { kind: "recovered" | "completed"; text: string };
  tier1?: boolean;
  tier2?: boolean;
}

function incidentText(params: {
  record: RegistryRecord;
  policy: SupervisionState["policy"];
  evidence: WorkerEvidence;
  incidentType: SupervisionIncidentType;
  silenceSec: number;
  level: "attention" | "escalation";
}): string {
  const { record, policy, evidence, incidentType, silenceSec, level } = params;
  return [
    `[${level.toUpperCase()}] ${incidentType}: ${record.hcomName ?? record.id}`,
    `harness: ${record.harness} | workspace: ${record.workspace}`,
    `silence: ${Math.round(silenceSec)}s (attention after ${policy.attentionAfterSec}s, escalation after ${policy.escalateAfterSec}s)`,
    `live status: ${evidence.liveAgent?.status ?? "gone"}${evidence.wedgedQueue ? " | wedged_queue evidence" : ""}`,
    `last meaningful activity: ${evidence.lastActivityKind ?? "none observed"}${evidence.lastActivityAtMs ? ` at ${new Date(evidence.lastActivityAtMs).toISOString()}` : ""}`,
    `outstanding dispatch/report: ${evidence.outstandingDispatch ? "yes" : "no"}`,
    `recommended: inspect with hcom term ${record.hcomName ?? record.id}; watch_agents for flags; unblock only if allowlisted.`,
  ].join("\n");
}

/**
 * Decide what one sweep pass does for one supervised worker. Pure: all time
 * comes from nowMs, all state from the inputs — tests drive it with a
 * controllable clock and literal fixtures.
 *
 * Lifecycle: open at the attention deadline against the CURRENT activity
 * generation; one attention alert, one escalation alert per generation
 * (failed deliveries retry because alertsSent only advances on success);
 * resolve when a NEWER generation appears (meaningful activity resumed).
 * Wake ladder on stalled_* incidents: tier1 in-band send at open, tier2
 * extended unblock one escalation window later, once each per generation.
 * blocked/lost/stopped_unreported notify immediately — there is nothing to
 * wake in-band, so no rescue tiers run for them.
 */
export function evaluateWorker(params: {
  record: RegistryRecord;
  supervision: SupervisionState;
  evidence: WorkerEvidence;
  nowMs: number;
}): SweepOutcome {
  const { record, evidence, nowMs } = params;
  const policy = params.supervision.policy;
  const supervision: SupervisionState = {
    ...params.supervision,
    ...(evidence.lastActivityAtMs !== null
      ? { lastActivityAt: new Date(evidence.lastActivityAtMs).toISOString() }
      : {}),
    ...(evidence.lastActivityKind ? { lastActivityKind: evidence.lastActivityKind } : {}),
  };

  const baselineMs = Math.max(
    eventTimeMs(supervision.baselineAt) ?? 0,
    evidence.lastActivityAtMs ?? 0,
  );
  const generation = new Date(baselineMs).toISOString();
  const silenceSec = (nowMs - baselineMs) / 1000;
  const existing = supervision.incident;

  // Resolution first: a newer generation than the open incident's means
  // meaningful activity resumed — resolve, inform the hub once (recovered),
  // and rebuild silence from the new activity.
  if (existing && generation !== existing.generation) {
    delete supervision.incident;
    return {
      supervision,
      inform: {
        kind: "recovered",
        text: `[RECOVERED] ${record.hcomName ?? record.id}: meaningful activity resumed (${evidence.lastActivityKind ?? "unknown kind"} at ${generation}); incident ${existing.type} resolved.`,
      },
    };
  }

  // Classification. Immediate types fire regardless of silence; stalled_*
  // need the attention deadline AND outstanding work. Reconcile has already
  // settled live-vs-record truth, so record.state is trusted here.
  let type: SupervisionIncidentType | null = null;
  if (!evidence.liveAgent) {
    if (record.state === "managed_stopped" || record.state === "adopted_stopped") {
      type = record.requireReport ? "stopped_unreported" : null;
    } else {
      type = "lost";
    }
  } else if (evidence.liveAgent.status === "blocked") {
    type = "blocked";
  } else if (silenceSec >= policy.attentionAfterSec) {
    if (evidence.liveAgent.status === "active") type = "stalled_active";
    else if (evidence.liveAgent.status === "listening" && evidence.outstandingDispatch) {
      type = "stalled_listening";
    }
  }

  // Routine lifecycle: completed/stopped cleanly — once per stopped
  // episode; the marker clears as soon as the agent is live again.
  if (
    !type &&
    !evidence.liveAgent &&
    (record.state === "managed_stopped" || record.state === "adopted_stopped")
  ) {
    if (!supervision.cleanStopInformedAt) {
      supervision.cleanStopInformedAt = new Date(nowMs).toISOString();
      return {
        supervision,
        inform: {
          kind: "completed",
          text: `[COMPLETED] ${record.hcomName ?? record.id}: stopped cleanly with no outstanding report.`,
        },
      };
    }
    return { supervision };
  }
  if (evidence.liveAgent && supervision.cleanStopInformedAt) {
    delete supervision.cleanStopInformedAt;
  }

  if (!type) {
    return { supervision };
  }

  const stalled = type === "stalled_active" || type === "stalled_listening";
  const outcome: SweepOutcome = { supervision };

  if (!existing) {
    // Open: persist-before-notify happens in the driver; this decision just
    // carries the fresh incident.
    supervision.incident = {
      type,
      openedAt: new Date(nowMs).toISOString(),
      generation,
      // Dedup fingerprint (#33): worker + type + activity generation.
      fingerprint: `${record.hcomName ?? record.id}:${type}:${generation}`,
      alertsSent: 0,
      deliveryFailed: false,
    };
    outcome.notify = {
      level: "attention",
      text: incidentText({ record, policy, evidence, incidentType: type, silenceSec, level: "attention" }),
    };
    if (stalled) outcome.tier1 = true;
    return outcome;
  }

  // Same generation: cap of one attention alert + one escalation alert.
  // Failed deliveries leave alertsSent unchanged, so the next sweep retries
  // the same level; deliveryFailed marks the retention that status /
  // list_managed / watch_agents surface.
  if (supervision.incident) {
    if (supervision.incident.alertsSent === 0) {
      outcome.notify = {
        level: "attention",
        text: incidentText({ record, policy, evidence, incidentType: type, silenceSec, level: "attention" }),
      };
    } else if (silenceSec >= policy.escalateAfterSec && supervision.incident.alertsSent === 1) {
      outcome.notify = {
        level: "escalation",
        text: incidentText({ record, policy, evidence, incidentType: type, silenceSec, level: "escalation" }),
      };
    }

    if (stalled) {
      if (!supervision.incident.tier1) {
        outcome.tier1 = true;
      } else {
        const tier1Ms = eventTimeMs(supervision.incident.tier1.at);
        if (
          !supervision.incident.tier2 &&
          tier1Ms !== null &&
          nowMs - tier1Ms >= policy.escalateAfterSec * 1000
        ) {
          outcome.tier2 = true;
        }
      }
    }
  }

  return outcome;
}

// --- Sweep driver ---

export interface SweepSummary {
  evaluated: number;
  incidentsOpened: number;
  incidentsResolved: number;
  alertsSent: number;
  alertsFailed: number;
  tier1Attempts: number;
  tier2Attempts: number;
}

const TIER1_WAKE_PROMPT =
  "[supervision wake] You have an unconsumed hub dispatch. Consume your message queue FIRST, then continue the task and report.";

/**
 * One service-level supervision pass over EVERY supervised owned record
 * (global, like reconcileGlobalRecords). Live-vs-record truth is settled
 * first by the Phase 0 global reconcile; incidents are persisted in ONE
 * batched registry write before notifications go out.
 */
export async function runSupervisionSweep(deps: {
  execHcomFn?: ExecHcomFn;
  now?: () => number;
  // Injectable live-truth source (defaults to the Phase 0 global reconcile).
  // Tests stub this so the sweep is fully deterministic under a controllable
  // clock regardless of module load order.
  reconcile?: () => Promise<{ records: RegistryRecord[]; liveAgents: HcomAgent[] }>;
} = {}): Promise<SweepSummary> {
  const execHcomFn = deps.execHcomFn ?? execHcom;
  const now = deps.now ?? Date.now;
  const reconcile = deps.reconcile ?? reconcileGlobalRecords;
  const summary: SweepSummary = {
    evaluated: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
    alertsSent: 0,
    alertsFailed: 0,
    tier1Attempts: 0,
    tier2Attempts: 0,
  };

  // Live truth first (Phase 0 reuse): one fetch, every owned record settled.
  const { records, liveAgents } = await reconcile();
  const nowMs = now();

  // #37: auto-adopt descendants of managed workers BEFORE evaluation so
  // fresh adoptees are swept on the next pass (their silence baseline
  // starts at adoption).
  await detectAndAdoptDescendants({ records, liveAgents, execHcomFn });

  const updates: { id: string; supervision: SupervisionState }[] = [];

  for (const record of records) {
    const hadIncident = Boolean(record.supervision?.incident);
    const supervision = resolveRecordSupervision(record);
    if (!supervision) continue;
    summary.evaluated += 1;

    const evidence = await fetchWorkerEvidence(record, liveAgents, nowMs, execHcomFn);
    const outcome = evaluateWorker({ record, supervision, evidence, nowMs });
    let next = outcome.supervision;

    if (!hadIncident && next.incident) summary.incidentsOpened += 1;
    if (hadIncident && !next.incident) summary.incidentsResolved += 1;

    if (outcome.inform) {
      const delivered = await deliverNotification(
        next.hub,
        next.thread,
        outcome.inform.text,
        execHcomFn,
        "inform",
      );
      if (!delivered) summary.alertsFailed += 1;
    }

    if (outcome.notify) {
      const delivered = await deliverNotification(
        next.hub,
        next.thread,
        outcome.notify.text,
        execHcomFn,
      );
      if (delivered) {
        summary.alertsSent += 1;
        next = {
          ...next,
          incident: next.incident
            ? {
                ...next.incident,
                alertsSent:
                  outcome.notify.level === "attention"
                    ? Math.max(next.incident.alertsSent, 1)
                    : Math.max(next.incident.alertsSent, 2),
                lastAlertAt: new Date(nowMs).toISOString(),
                deliveryFailed: false,
              }
            : next.incident,
        };
      } else {
        summary.alertsFailed += 1;
        next = {
          ...next,
          incident: next.incident
            ? { ...next.incident, deliveryFailed: true }
            : next.incident,
        };
      }
    }

    if (outcome.tier1 && next.incident) {
      summary.tier1Attempts += 1;
      const result = await sendTier1Wake(record.hcomName ?? "", execHcomFn);
      next = {
        ...next,
        incident: { ...next.incident!, tier1: { at: new Date(nowMs).toISOString(), outcome: result } },
      };
    }

    if (outcome.tier2 && next.incident) {
      summary.tier2Attempts += 1;
      const result = await runTier2Wake(record, execHcomFn);
      next = {
        ...next,
        incident: { ...next.incident!, tier2: { at: new Date(nowMs).toISOString(), outcome: result } },
      };
    }

    updates.push({ id: record.id, supervision: next });
  }

  applySupervisionUpdates(updates);

  return summary;
}

/**
 * Tier 2 (out-of-band): extended unblock for a listening agent carrying
 * wedged_queue/stalled_listening evidence. The unblock gate extension
 * (see tools/unblock.ts) enforces the dispatch-intent allowlist, dry-run
 * default, and one-attempt-per-generation; the wake prompt instructs the
 * worker to consume its queue first.
 */
async function runTier2Wake(record: RegistryRecord, execHcomFn: ExecHcomFn): Promise<string> {
  const name = record.hcomName ?? "";
  if (!name) return "tier2 skipped: record has no hcom name";
  // Dynamic import keeps the rescue path out of the supervisor's link
  // surface (same pattern as verifyAgent's rescue loop).
  const { runUnblock } = await import("./tools/unblock.js");
  const rescue = await runUnblock(name, {
    workspace: record.workspace,
    dryRun: false,
    text: TIER1_WAKE_PROMPT,
    waitSec: 15,
    execHcomFn,
    supervisionRescue: true,
  });
  return rescue.ok
    ? `tier2 wake injected (${rescue.state ?? "unknown"} after recheck)`
    : `tier2 refused or failed: ${rescue.text.slice(0, 200)}`;
}

async function deliverNotification(
  hub: string,
  thread: string | undefined,
  text: string,
  execHcomFn: ExecHcomFn,
  intent: "request" | "inform" = "request",
): Promise<boolean> {
  if (!hub) return false; // missing hub: retained, surfaced as deliveryFailed
  const args = thread
    ? ["send", `@${hub}`, "--thread", thread, "--intent", intent, "--", text]
    : ["send", `@${hub}`, "--intent", intent, "--", text];
  const result = await execHcomFn(args);
  return result.exitCode === 0;
}

async function sendTier1Wake(name: string, execHcomFn: ExecHcomFn): Promise<string> {
  const result = await execHcomFn(["send", `@${name}`, "--intent", "request", "--", TIER1_WAKE_PROMPT]);
  return result.exitCode === 0 ? "tier1 wake sent" : `tier1 wake failed: ${result.stderr || result.stdout}`;
}

// --- Service-level loop ---

// ponytail: fixed 30s cadence, single in-process interval, overlap-guarded.
// Per-worker timers would be hundreds of disposable setTimeouts doing what
// one pass over the registry does; tune here if the fleet grows.
const SWEEP_INTERVAL_MS = 30_000;

let sweepRunning = false;

/**
 * Start the in-process supervision loop: one rehydration sweep immediately
 * (service start resumes supervision from the registry — deadlines live in
 * the records, so a restart neither resets silence windows nor duplicates
 * alerts), then a sweep every SWEEP_INTERVAL_MS. Returns a stop function.
 */
export function startSupervisor(
  deps: { execHcomFn?: ExecHcomFn; now?: () => number } = {},
): () => void {
  const tick = async () => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      const summary = await runSupervisionSweep(deps);
      // Empirical wake-ladder telemetry (#33 owner decision): tier success
      // rates are reported per milestone from these counters.
      if (summary.incidentsOpened || summary.incidentsResolved || summary.tier1Attempts || summary.tier2Attempts || summary.alertsFailed) {
        console.error(
          `[supervision] sweep: opened=${summary.incidentsOpened} resolved=${summary.incidentsResolved} ` +
            `alerts=${summary.alertsSent} failed=${summary.alertsFailed} ` +
            `tier1=${summary.tier1Attempts} tier2=${summary.tier2Attempts}`,
        );
      }
    } catch (err: any) {
      // A failed sweep must never take the MCP server down; the next tick
      // retries and the registry stays authoritative.
      console.error("[supervision] sweep failed:", err?.message ?? err);
    } finally {
      sweepRunning = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
