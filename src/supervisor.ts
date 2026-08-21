import { execHcom } from "./hcom.js";
import type { ExecHcomFn } from "./supervision.js";
import {
  defaultSupervisionPolicy,
  ensureSupervisionSubscriptions,
  listSubscriptionIds,
  SUPERVISOR_IDENTITY,
} from "./supervision.js";
import {
  eventData,
  eventTimeMs,
  isAgentMessageEvent,
  isInboundDispatchEvent,
  messageFields,
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
  getReleasedSupervisionRecords,
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
  // Outstanding dispatch intent at observation time (supervisor-originated
  // messages filtered out) — captured onto incidents for the tier2 gate.
  dispatchIntent: string | null;
  // One-line-per-event summary of the most recent activity, for incident
  // diagnostics (#33 notification contract).
  recentEventsSummary: string[];
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
      dispatchIntent: null,
      recentEventsSummary: [],
    };
  }
  const [agentEvents, inboundEvents] = await Promise.all([
    fetchAgentEvents(liveAgent.base_name, execHcomFn),
    fetchInboundEvents(liveAgent.base_name, execHcomFn),
  ]);
  const activity = latestMeaningfulActivity(liveAgent.base_name, agentEvents);
  const wedged = await detectWedgedQueue(liveAgent, agentEvents, inboundEvents, nowMs, execHcomFn);
  return {
    liveAgent,
    lastActivityAtMs: activity?.atMs ?? null,
    lastActivityKind: activity?.kind ?? null,
    outstandingDispatch: hasOutstandingDispatch({ record, liveAgent, agentEvents, inboundEvents }),
    wedgedQueue: Boolean(wedged),
    dispatchIntent: latestInboundIntent(inboundEvents, liveAgent.base_name),
    recentEventsSummary: summarizeEvents([...agentEvents].slice(-5)),
  };
}

/** Latest inbound non-ack dispatch intent, ignoring supervisor wakes (M6). */
function latestInboundIntent(inboundEvents: HcomEvent[], agentName: string): string | null {
  const latest = newestEvent(
    inboundEvents.filter((event) => {
      if (!isInboundDispatchEvent(event, agentName)) return false;
      const data = eventData(event);
      if (data.from === SUPERVISOR_IDENTITY) return false;
      if (typeof data.text === "string" && data.text.startsWith("[supervision wake]")) return false;
      return true;
    }),
  );
  return latest ? messageFields(latest).intent ?? null : null;
}

/** Compact diagnostic lines for the most recent events. */
function summarizeEvents(events: HcomEvent[]): string[] {
  return events.map((event) => {
    const data = eventData(event);
    const bits = [event.type ?? "life", String(data.action ?? data.status ?? data.new_status ?? "")];
    if (typeof data.from === "string") bits.push(`from=${data.from}`);
    if (typeof data.context === "string") bits.push(data.context);
    if (typeof data.new_context === "string") bits.push(data.new_context);
    const text = typeof data.text === "string" ? data.text.slice(0, 60) : "";
    return `${event.ts ?? "?"} [${bits.filter(Boolean).join(" ")}]${text ? ` ${text}` : ""}`.trim();
  });
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
  const adopted = record.state.startsWith("adopted_");
  // Manual adopts carry no launchedBy and are NEVER supervised: they may be
  // headed human-operated sessions, and waking or injecting into one is
  // exactly what the ambiguous-silence rules forbid. Auto-adopted
  // descendants (#37) DO carry launchedBy (the root launcher's hub) and are
  // supervised like launches — that is what extends coverage to the tree.
  if (adopted && !record.launchedBy) return null;
  if (record.launchMode === "headed") return null;
  // Belt: an adopted record with undeterminable mode AND no owner proxy is
  // default-deny even if some future writer forgets the proxy.
  if (adopted && record.launchMode === undefined && !record.launchedBy) return null;
  if (record.supervision) {
    // An explicit block is authoritative INCLUDING its enabled flag (B2):
    // supervise:false must never be re-enabled by the default-closed
    // fallback.
    return record.supervision.policy.enabled ? record.supervision : null;
  }
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
  // Confirmed terminal state (stopped cleanly / stopped_unreported / lost):
  // the worker's push-lane subscriptions can never fire again — remove
  // them (#33 cleanup).
  cleanupSubscriptions?: boolean;
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
  // Activity evidence is only meaningful while the agent is live: a dead
  // agent's event window collapsing to empty must NOT regress the
  // generation (M5 — false RECOVERED then duplicate re-alert).
  const supervision: SupervisionState = {
    ...params.supervision,
    ...(evidence.liveAgent && evidence.lastActivityAtMs !== null
      ? { lastActivityAt: new Date(evidence.lastActivityAtMs).toISOString() }
      : {}),
    ...(evidence.liveAgent && evidence.lastActivityKind
      ? { lastActivityKind: evidence.lastActivityKind }
      : {}),
  };

  const baselineMs = Math.max(
    eventTimeMs(supervision.baselineAt) ?? 0,
    evidence.liveAgent ? evidence.lastActivityAtMs ?? 0 : 0,
  );
  const generation = new Date(baselineMs).toISOString();
  const silenceSec = (nowMs - baselineMs) / 1000;
  const existing = supervision.incident;

  // Resolution first: a STRICTLY NEWER generation while the agent is live
  // means meaningful activity resumed — resolve, inform the hub once
  // (recovered), and rebuild silence from the new activity.
  if (
    existing &&
    evidence.liveAgent &&
    baselineMs > (eventTimeMs(existing.generation) ?? 0)
  ) {
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
      const closed = closeIncident(supervision, nowMs);
      return {
        supervision: closed,
        inform: {
          kind: "completed",
          text: `[COMPLETED] ${record.hcomName ?? record.id}: stopped cleanly with no outstanding report.`,
        },
        cleanupSubscriptions: true,
      };
    }
    // Already informed for this episode; still confirm cleanup is done.
    return {
      supervision: closeIncident(supervision, nowMs),
      cleanupSubscriptions: supervision.subscriptions.length > 0,
    };
  }
  if (evidence.liveAgent && supervision.cleanStopInformedAt) {
    delete supervision.cleanStopInformedAt;
  }

  if (!type) {
    return { supervision };
  }

  const stalled = type === "stalled_active" || type === "stalled_listening";
  const outcome: SweepOutcome = { supervision };

  // Terminal states: nothing to watch anymore — drop the push lane. The
  // incident itself is closed AFTER the open/reopen logic below so a
  // material type change (e.g. stalled -> lost) is what gets recorded.
  if (!evidence.liveAgent) {
    outcome.cleanupSubscriptions = true;
  }

  if (!existing) {
    // Part (b): an identical incident (same type AND generation) that was
    // already CLOSED is spent — reopening it would re-alert every sweep
    // forever, because the close wipes the budget the cap needs.
    const closed = supervision.lastIncident;
    if (closed && closed.type === type && closed.generation === generation) {
      return outcome;
    }
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
      dispatchIntent: evidence.dispatchIntent,
    };
    outcome.notify = {
      level: "attention",
      text: incidentText({ record, policy, evidence, incidentType: type, silenceSec, level: "attention" }),
    };
    if (stalled) outcome.tier1 = true;
  } else {
    // Same generation. A MATERIAL TYPE CHANGE (m10/A) mutates the incident
    // in place — type + fingerprint updated, alert budget and wake history
    // CARRIED FORWARD — so a flapping status can never mint fresh budgets
    // or re-fire tier1 inside one generation. Escalation text reports the
    // current type because it is composed from these fields at send time.
    if (supervision.incident) {
      if (supervision.incident.type !== type) {
        supervision.incident.type = type;
        supervision.incident.fingerprint = `${record.hcomName ?? record.id}:${type}:${generation}`;
      }
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

      // Tier2 PTY injection only for stalled_listening (m19): stalled_active
      // means the harness IS working — injecting into it is corruption, and
      // the unblock gate would refuse anyway.
      if (type === "stalled_listening") {
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
  }

  // Terminal close, ONCE there is nothing left to say (part a): closing on
  // the alerting sweep would wipe the incident and re-arm the reopen on
  // the next pass; closing before the escalation deadline would silently
  // drop the second alert. So: no pending notification AND the two-slot
  // budget is spent (or there was never an incident to speak about).
  const budgetSpent =
    !outcome.supervision.incident || outcome.supervision.incident.alertsSent >= 2;
  if (outcome.cleanupSubscriptions && !outcome.notify && !outcome.inform && budgetSpent) {
    outcome.supervision = closeIncident(outcome.supervision, nowMs);
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

  // #33 M4 rehydration: one `events sub list` call verifies every stored
  // subscription id. Kinds hcom dropped are reinstalled exactly once;
  // surviving ids are never duplicated. Records with NO subscriptions are
  // left alone — first-time installation stays a launch-time job.
  const subIds = await listSubscriptionIds(execHcomFn);

  // #37: auto-adopt descendants of managed workers BEFORE evaluation so
  // fresh adoptees are swept on the next pass (their silence baseline
  // starts at adoption).
  await detectAndAdoptDescendants({ records, liveAgents, execHcomFn });

  const updates: { id: string; supervision: SupervisionState | undefined; clearSubscriptions?: boolean }[] = [];

  // Per-record handler. Failure-isolated (M4): one throw (e.g. a transient
  // 'hcom list' failure inside a tier2 recheck) is logged and the record's
  // latest state is still persisted — alerts already delivered are never
  // lost to a later throw, so budgets and attempt records stay truthful.
  const evaluateOne = async (record: RegistryRecord): Promise<void> => {
    // Hoisted so the catch can persist whatever state was computed before a
    // throw (M4/M-C): budgets and attempt records stay truthful even when
    // delivery-side code blows up mid-pass.
    let next: SupervisionState | undefined;
    try {
      const hadIncident = Boolean(record.supervision?.incident);
      let supervision = resolveRecordSupervision(record);
      if (!supervision) return;
      summary.evaluated += 1;

      // Rehydration: reinstall only kinds whose stored id hcom no longer has.
      const terminalState =
        record.state === "managed_stopped" ||
        record.state === "adopted_stopped" ||
        record.state === "managed_lost" ||
        record.state === "adopted_lost";
      if (
        !terminalState &&
        subIds &&
        supervision.subscriptions.length > 0 &&
        supervision.hub &&
        supervision.subscriptions.some((sub) => !subIds.has(sub.subId))
      ) {
        const alive = supervision.subscriptions.filter((sub) => subIds.has(sub.subId));
        const res = await ensureSupervisionSubscriptions(
          supervision.hub,
          record.hcomName ?? "",
          alive,
          execHcomFn,
          async (subId: string) => Boolean(subIds?.has(subId)),
        );
        supervision = {
          ...supervision,
          subscriptions: res.subscriptions,
          ...(res.errors.length > 0 ? { installErrors: res.errors } : {}),
        };
      }

      const evidence = await fetchWorkerEvidence(record, liveAgents, nowMs, execHcomFn);
      const outcome = evaluateWorker({ record, supervision, evidence, nowMs });
      next = outcome.supervision;

      if (!hadIncident && next.incident) summary.incidentsOpened += 1;
      // m24: a resolution is the RECOVERED transition — cleanup-closes of
      // terminal workers are lifecycle evidence, not resolutions.
      if (outcome.inform?.kind === "recovered") summary.incidentsResolved += 1;

      // M3: persist the incident BEFORE any notification goes out (m20:
      // informs included), so a throw during delivery can never lose an
      // alerted incident or double-fire an inform.
      if (outcome.notify || outcome.inform || outcome.tier1 || outcome.tier2) {
        applySupervisionUpdates([{ id: record.id, supervision: next }]);
      }

      if (outcome.inform) {
        const delivered = await deliverNotification(
          next.hub,
          outcome.inform.text,
          execHcomFn,
          "inform",
        );
        if (!delivered) summary.alertsFailed += 1;
      }

      if (outcome.notify) {
        // M8: enrich the alert with recent events, terminal tail, and the
        // rescue-attempted line before it leaves the building.
        const enriched = await enrichIncidentText(
          outcome.notify.text,
          next.incident,
          record.hcomName ?? "",
          evidence.recentEventsSummary,
          execHcomFn,
        );
        const delivered = await deliverNotification(next.hub, enriched, execHcomFn);
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

      // #33 cleanup: confirmed terminal workers lose their push lane — the
      // subscriptions can never fire again and must not accumulate.
      let cleared = false;
      if (outcome.cleanupSubscriptions && next.subscriptions.length > 0) {
        await Promise.allSettled(
          next.subscriptions.map((sub) => execHcomFn(["events", "unsub", sub.subId])),
        );
        next = { ...next, subscriptions: [] };
        cleared = true;
      }

      updates.push({ id: record.id, supervision: next, clearSubscriptions: cleared });
    } catch (err: any) {
      console.error(
        `[supervision] record ${record.id} (${record.hcomName ?? "?"}) failed:`,
        err?.message ?? err,
      );
      // Whatever was computed before the throw survives: delivered alerts
      // keep their budget bumps, attempted tiers keep their records.
      if (next) updates.push({ id: record.id, supervision: next });
    }
  };

  // m14: bounded concurrency — serial awaits over a large live fleet would
  // outrun the sweep interval; unbounded Promise.all would saturate the CLI.
  await mapWithConcurrency(records, 4, evaluateOne);

  // Orphaned-subscription reconciliation, safe subset (#33 cleanup):
  // RELEASED records keep no push lane — their subscriptions are removed
  // and the supervision block closed. Records already deleted (e.g. by
  // prune) are NOT scanned globally: mass-unsubscribing hcom entities
  // without a record boundary is a destructive, owner-consent operation.
  for (const record of getReleasedSupervisionRecords()) {
    if (record.supervision && record.supervision.subscriptions.length > 0) {
      await Promise.allSettled(
        record.supervision.subscriptions.map((sub) => execHcomFn(["events", "unsub", sub.subId])),
      );
    }
    updates.push({
      id: record.id,
      supervision: record.supervision
        ? withoutIncident({ ...record.supervision, subscriptions: [] })
        : record.supervision,
      clearSubscriptions: true,
    });
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
    sender_name: SUPERVISOR_IDENTITY,
    dryRun: false,
    text: TIER1_WAKE_PROMPT,
    waitSec: 15,
    execHcomFn,
    supervisionRescue: true,
    wakeIntentOverride: nextIncidentDispatchIntent(record),
  });
  return rescue.ok
    ? `tier2 wake injected (${rescue.state ?? "unknown"} after recheck)`
    : `tier2 refused or failed: ${rescue.text.slice(0, 200)}`;
}

/** Shallow copy without the open incident (optional field, delete-safe). */
function withoutIncident(supervision: SupervisionState): SupervisionState {
  const next = { ...supervision };
  delete next.incident;
  return next;
}

/** Close an open incident: retained as lastIncident evidence (m11). */
function closeIncident(supervision: SupervisionState, nowMs: number): SupervisionState {
  if (!supervision.incident) return supervision;
  const { incident, ...rest } = supervision;
  return { ...rest, lastIncident: { ...incident, closedAt: new Date(nowMs).toISOString() } };
}

/** Run async work over items with bounded concurrency, preserving order of results. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

/**
 * M8: append recent-event summary, terminal tail, and rescue-attempted
 * lines to the base incident text at SEND time (the tail costs one
 * subprocess per alerting record, not per evaluated record).
 */
async function enrichIncidentText(
  baseText: string,
  incident: SupervisionState["incident"],
  name: string,
  recentEventsSummary: string[],
  execHcomFn: ExecHcomFn,
): Promise<string> {
  const lines: string[] = [];
  if (recentEventsSummary.length > 0) {
    lines.push(`recent events:\n  ${recentEventsSummary.join("\n  ")}`);
  }
  try {
    const { fetchScreenTail } = await import("./tools/unblock.js");
    lines.push(`terminal tail:\n  ${(await fetchScreenTail(name, execHcomFn)).split("\n").join("\n  ")}`);
  } catch {
    lines.push("terminal tail: unavailable");
  }
  const tier1 = incident?.tier1 ? `tier1 (${incident.tier1.outcome})` : null;
  const tier2 = incident?.tier2 ? `tier2 (${incident.tier2.outcome})` : null;
  lines.push(`rescue attempted: ${[tier1, tier2].filter(Boolean).join(", ") || "none"}`);
  return `${baseText}\n${lines.join("\n")}`;
}

async function deliverNotification(
  hub: string,
  text: string,
  execHcomFn: ExecHcomFn,
  intent: "request" | "inform" = "request",
): Promise<boolean> {
  if (!hub) return false; // missing hub: retained, surfaced as deliveryFailed
  // m13: workflow-thread routing dropped — nothing populates a thread at
  // launch time today; re-add routing when topology launches seed threads.
  const args = [
    "send", `@${hub}`, "--from", SUPERVISOR_IDENTITY,
    "--intent", intent, "--", text,
  ];
  const result = await execHcomFn(args);
  return result.exitCode === 0;
}

/**
 * The outstanding dispatch intent captured when the record's incident was
 * opened (M6): tier2's allowlist gate checks this instead of the newest
 * inbound message, which after tier1 is the supervisor's own wake.
 */
function nextIncidentDispatchIntent(record: RegistryRecord): string | null {
  return record.supervision?.incident?.dispatchIntent ?? null;
}

async function sendTier1Wake(name: string, execHcomFn: ExecHcomFn): Promise<string> {
  const result = await execHcomFn(["send", `@${name}`, "--from", SUPERVISOR_IDENTITY, "--intent", "request", "--", TIER1_WAKE_PROMPT]);
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
      const sweepStarted = Date.now();
      const summary = await runSupervisionSweep(deps);
      if (Date.now() - sweepStarted > SWEEP_INTERVAL_MS) {
        console.error("[supervision] sweep exceeded its interval; ticks were skipped by the overlap guard");
      }
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
