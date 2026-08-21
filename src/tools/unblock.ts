import { z } from "zod";
import {
  execHcom,
  findLiveAgentByIdentifier,
  listHcomAgents,
  resolveCallerName,
} from "../hcom.js";
import { parseLifeEvents, parseTermJson } from "../gate.js";
import { loadMergedConfig } from "../config.js";
import { getOwnedRecordsByWorkspace, updateRecordState } from "../registry.js";
import { validateStopKillTarget } from "./lifecycle.js";
import { detectWedgedQueue, fetchAgentEvents, fetchInboundEvents } from "./watch.js";
import { isInboundDispatchEvent, messageFields, newestEvent, type HcomEvent } from "../events.js";
import { SUPERVISOR_IDENTITY } from "../supervision.js";
import type { RegistryRecord } from "../types.js";
import {
  E_AGENT_NOT_LIVE,
  E_AGENT_NOT_BLOCKED,
  E_INJECTION_FAILED,
  E_INJECTION_REFUSED,
  internalError,
  toolError,
} from "../errors.js";

const SCREEN_TAIL_LINES = 30;

/**
 * Stalled-listening evidence without the full wedged_queue threshold: a
 * listening agent whose status has been quiet far longer than one
 * supervision escalation window. Used by the tier2 gate as the fallback
 * signal when OpenCode-specific wedge evidence is absent.
 */
function isStalledListening(live: { status: string; status_age_seconds?: number }): boolean {
  return live.status === "listening" && (live.status_age_seconds ?? 0) >= 600;
}

/**
 * Intent of the latest inbound non-ack dispatch, for the wake-intent gate.
 * Supervisor-originated messages (tier1 wakes) are filtered out — the gate
 * must never pass on evidence the supervisor manufactured.
 */
function latestDispatchIntent(inboundEvents: HcomEvent[], agentName: string): string | null {
  const latest = newestEvent(
    inboundEvents.filter((event) => {
      if (!isInboundDispatchEvent(event, agentName)) return false;
      const { from, text } = messageFields(event);
      if (from === SUPERVISOR_IDENTITY) return false;
      if (typeof text === "string" && text.startsWith("[supervision wake]")) return false;
      return true;
    }),
  );
  return latest ? messageFields(latest).intent ?? null : null;
}

/**
 * Match the launch_blocked detail text against the config rescue allowlist.
 * A match means the dialog is known-rescuable (workspace trust, permission
 * mode, model/provider picker) and one Enter is a safe, bounded action.
 */
export function isRescuableDetail(
  detail: string | undefined,
  patterns: string[],
): boolean {
  if (!detail) return false;
  const haystack = detail.toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()));
}

/**
 * Fetch the pending launch_blocked detail for an agent from the life event
 * stream. Returns undefined when the agent is not blocked (or the event is
 * gone from the window).
 */
export async function fetchBlockedDetail(
  name: string,
  execHcomFn: typeof execHcom = execHcom,
): Promise<{ reason?: string; detail?: string } | undefined> {
  const result = await execHcomFn(["events", "--last", "50", "--type", "life", "--agent", name]);
  if (result.exitCode !== 0) return undefined;
  const events = parseLifeEvents(result.stdout);
  const blocked = events.find((e) => e.action === "launch_blocked");
  if (!blocked) return undefined;
  return { reason: blocked.reason, detail: blocked.detail };
}

/**
 * Re-check an agent after a rescue injection: bounded wait for a terminal
 * launch event (ready / launch_blocked_cleared / launch_failed), then a live
 * status read. Returns the observed state.
 */
export async function recheckAfterRescue(
  name: string,
  waitSec: number,
  execHcomFn: typeof execHcom = execHcom,
): Promise<{ state: "ready" | "blocked" | "failed" | "unknown"; detail?: string }> {
  const waitResult = await execHcomFn(["events", "--wait", String(waitSec), "--type", "life", "--agent", name]);
  if (waitResult.exitCode === 0) {
    const events = parseLifeEvents(waitResult.stdout);
    const terminal = events.find(
      (e) =>
        e.action === "ready" ||
        e.action === "launch_blocked_cleared" ||
        e.action === "launch_failed",
    );
    if (terminal?.action === "ready" || terminal?.action === "launch_blocked_cleared") {
      return { state: "ready" };
    }
    if (terminal?.action === "launch_failed") {
      return { state: "failed", detail: terminal.detail };
    }
  }

  // No terminal event within the window: read the live status to distinguish
  // "still blocked" from "gone".
  const agents = await listHcomAgents();
  const live = findLiveAgentByIdentifier(name, agents);
  if (!live) return { state: "failed", detail: "agent no longer live in hcom" };
  if (live.status === "blocked") return { state: "blocked" };
  return { state: "ready" };
}

/**
 * Read the current terminal screen tail for an agent.
 */
export async function fetchScreenTail(
  name: string,
  execHcomFn: typeof execHcom = execHcom,
): Promise<string> {
  const result = await execHcomFn(["term", name, "--json"]);
  if (result.exitCode !== 0) {
    return `(hcom term failed: ${result.stderr || result.stdout})`;
  }
  const screen = parseTermJson(result.stdout);
  const lines = screen.lines ?? [];
  return lines.slice(-SCREEN_TAIL_LINES).join("\n");
}

/**
 * Inject a single Enter (or optional text) into the agent's PTY. One rescue
 * attempt max per gate; a dialog surviving one Enter needs a human.
 */
export async function injectRescue(
  name: string,
  text: string | undefined,
  execHcomFn: typeof execHcom = execHcom,
): Promise<{ ok: boolean; error?: string }> {
  const args = text
    ? ["term", "inject", name, text, "--enter"]
    : ["term", "inject", name, "--enter"];
  const result = await execHcomFn(args);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || result.stdout };
  }
  return { ok: true };
}

/**
 * The unblock flow shared by the unblock tool, spawn_and_verify rescue, and
 * the M2 supervision wake ladder (tier2): validate ownership + state,
 * dry-run report, optional guarded injection, bounded re-check, registry
 * transition.
 *
 * supervisionRescue extends the gate to LISTENING agents carrying
 * wedged_queue/stalled_listening evidence (owner decision, issue #33
 * comment): the detector flags those but the classic gate only served
 * blocked agents. The dispatch-intent allowlist still applies — an
 * ambiguous silence is never auto-injected — and the caller owns
 * one-attempt-per-incident-generation; this function stays stateless.
 */
export async function runUnblock(
  name: string,
  options: {
    workspace?: string;
    sender_name?: string;
    dryRun?: boolean;
    text?: string;
    waitSec?: number;
    execHcomFn?: typeof execHcom;
    supervisionRescue?: boolean;
    // M6: explicit outstanding-dispatch intent captured at incident-open
    // time. When provided it REPLACES the newest-inbound derivation, so the
    // supervisor's own tier1 wake can never satisfy the allowlist.
    wakeIntentOverride?: string | null;
  } = {},
): Promise<{
  ok: boolean;
  isError?: boolean;
  text: string;
  injected?: boolean;
  state?: "ready" | "blocked" | "failed" | "unknown";
  detail?: string;
}> {
  const cwd = options.workspace ?? process.cwd();
  const execHcomFn = options.execHcomFn ?? execHcom;
  const dryRun = options.dryRun ?? true;

  const validation = await validateStopKillTarget(name, "unblock", options.sender_name, cwd);
  if (!validation.ok) {
    return { ok: false, isError: true, text: validation.response.content[0].text };
  }

  const { owned, canonicalName } = validation;

  // Refuse unless the agent is live AND (blocked OR a supervision rescue
  // against a listening agent with wedge/stall evidence). Injecting Enter
  // into a working agent is silent corruption.
  const agents = await listHcomAgents();
  const live = findLiveAgentByIdentifier(canonicalName, agents);
  if (!live) {
    return {
      ok: false,
      isError: true,
      text: toolError(E_AGENT_NOT_LIVE, `Agent "${name}" is not live in hcom.`).content[0].text,
    };
  }

  let wedgedEvidence: Awaited<ReturnType<typeof detectWedgedQueue>> | undefined;
  let supervisionIntent: string | undefined | null;
  if (live.status !== "blocked") {
    if (!options.supervisionRescue || live.status !== "listening") {
      return {
        ok: false,
        isError: true,
        text: toolError(
          E_AGENT_NOT_BLOCKED,
          `Agent "${name}" is not blocked (status: ${live.status}). Refusing to inject input into a working agent.`,
        ).content[0].text,
      };
    }
    // Supervision rescue: require concrete wedge/stall evidence before any
    // injection into a listening agent, and capture the outstanding
    // dispatch intent for the allowlist gate below.
    const [agentEvents, inboundEvents] = await Promise.all([
      fetchAgentEvents(live.base_name, execHcomFn),
      fetchInboundEvents(live.base_name, execHcomFn),
    ]);
    wedgedEvidence = await detectWedgedQueue(live, agentEvents, inboundEvents);
    supervisionIntent =
      options.wakeIntentOverride !== undefined
        ? options.wakeIntentOverride
        : wedgedEvidence?.dispatchIntent ?? latestDispatchIntent(inboundEvents, live.base_name);
    if (!wedgedEvidence && !isStalledListening(live)) {
      return {
        ok: false,
        isError: true,
        text: toolError(
          E_AGENT_NOT_BLOCKED,
          `Agent "${name}" is listening without wedged_queue or stalled evidence; refusing to inject.`,
        ).content[0].text,
      };
    }
  }

  const blockedDetail = await fetchBlockedDetail(canonicalName, execHcomFn);
  const screenTail = await fetchScreenTail(canonicalName, execHcomFn);

  const report = {
    agent: name,
    dryRun,
    status: live.status,
    blockedDetail: blockedDetail?.detail ?? null,
    blockedReason: blockedDetail?.reason ?? null,
    ...(supervisionIntent !== undefined || wedgedEvidence
      ? {
          supervisionRescue: true,
          dispatchIntent: supervisionIntent ?? null,
          wedgedQueue: Boolean(wedgedEvidence),
        }
      : {}),
    screenTail,
  };

  if (dryRun) {
    return {
      ok: true,
      text: JSON.stringify(report, null, 2),
    };
  }

  // Live injection path: allowlist gate before touching the keyboard.
  const config = loadMergedConfig(cwd);
  const allowlist = config.rescueAllowlist;
  if (!allowlist.enabled) {
    return {
      ok: false,
      isError: true,
      text: JSON.stringify({
        ...report,
        error: `[${E_INJECTION_REFUSED}] Rescue allowlist is disabled in config; refusing to inject.`,
      }, null, 2),
    };
  }
  if (live.status === "blocked") {
    if (!isRescuableDetail(blockedDetail?.detail, allowlist.patterns)) {
      return {
        ok: false,
        isError: true,
        text: JSON.stringify({
          ...report,
          error: `[${E_INJECTION_REFUSED}] Blocked detail does not match any rescue allowlist pattern; refusing to inject. Add a pattern to rescueAllowlist in config if this dialog is known-safe.`,
        }, null, 2),
      };
    }
  } else {
    // Supervision rescue against a listening agent: the outstanding
    // dispatch's intent must be on the wake-intent allowlist. Ambiguous
    // silence with no dispatch at all is never auto-injected.
    const wakeIntents = allowlist.wakeIntents ?? ["request"];
    if (!supervisionIntent || !wakeIntents.includes(supervisionIntent as "request" | "inform" | "ack")) {
      return {
        ok: false,
        isError: true,
        text: JSON.stringify({
          ...report,
          error: `[${E_INJECTION_REFUSED}] Outstanding dispatch intent "${supervisionIntent ?? "none"}" is not on the wake-intent allowlist (${wakeIntents.join(", ")}); refusing to inject.`,
        }, null, 2),
      };
    }
  }

  const injection = await injectRescue(canonicalName, options.text, execHcomFn);
  if (!injection.ok) {
    return {
      ok: false,
      isError: true,
      text: JSON.stringify({ ...report, error: `[${E_INJECTION_FAILED}] Injection failed: ${injection.error}` }, null, 2),
    };
  }

  const recheck = await recheckAfterRescue(canonicalName, options.waitSec ?? 15, execHcomFn);

  // Registry transition: managed_blocked → managed_active on success.
  if (recheck.state === "ready" && owned.state === "managed_blocked") {
    updateRecordState(owned.id, "managed_active");
  }

  return {
    ok: recheck.state === "ready",
    injected: true,
    state: recheck.state,
    detail: recheck.detail,
    text: JSON.stringify({
      ...report,
      injected: true,
      recheck: recheck,
      registryTransition:
        recheck.state === "ready" && owned.state === "managed_blocked"
          ? "managed_blocked -> managed_active"
          : "none",
    }, null, 2),
  };
}

export function registerUnblockTool(server: any) {
  server.tool(
    "unblock",
    "Guarded PTY rescue for a blocked agent. Dry-run by default: returns the screen tail and pending launch_blocked detail without injecting. With dry_run=false, injects a single Enter (or optional text) only when the blocked detail matches the config rescue allowlist, then transitions managed_blocked -> managed_active on success. One attempt max; a dialog surviving one Enter needs a human. Preconditions: agent owned (E_NOT_MANAGED), live (E_AGENT_NOT_LIVE), and blocked (E_AGENT_NOT_BLOCKED); sender identity (see sender_name). Related: spawn_and_verify (on_blocked=rescue), watch_agents (blocked flag).",
    {
      name: z.string().describe("hcom agent name"),
      workspace: z.string().optional().describe("Workspace path for ownership verification. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace); ownership records are scoped per workspace."),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
      dry_run: z.boolean().optional().describe("Report only, inject nothing (default: true)"),
      text: z.string().optional().describe("Optional text to inject; Enter-only when omitted"),
    },
    async ({ name, workspace, sender_name, dry_run, text }: {
      name: string;
      workspace?: string;
      sender_name?: string;
      dry_run?: boolean;
      text?: string;
    }) => {
      const result = await runUnblock(name, {
        workspace,
        sender_name,
        dryRun: dry_run,
        text,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.isError ? { isError: true as const } : {}),
      };
    }
  );
}
