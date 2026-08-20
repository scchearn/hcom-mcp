import { z } from "zod";
import {
  canonicalizeAgentName,
  execHcom,
  findLiveAgentByIdentifier,
  listHcomAgents,
  resolveCallerName,
} from "../hcom.js";
import { getOwnedRecordsByWorkspace, updateRecordState } from "../registry.js";
import type { RegistryRecord, HcomAgent } from "../types.js";
import {
  E_AGENT_NOT_FOUND,
  E_KILL_FAILED,
  E_NO_SENDER,
  E_NOT_MANAGED,
  E_REPORT_REQUIRED,
  E_SELF_PROTECTION,
  E_STOP_FAILED,
  E_TARGET_REQUIRED,
  internalError,
  toolError,
} from "../errors.js";

function formatManagedNames(names: Array<string | undefined>) {
  const filtered = names.filter(Boolean);
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

interface LifecycleEvent {
  type?: string;
  ts?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

function parseLifecycleEvents(stdout: string): LifecycleEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as LifecycleEvent;
        return event && typeof event === "object" ? [event] : [];
      } catch {
        return [];
      }
    });
}

function eventTimeMs(event: LifecycleEvent): number | null {
  const raw = event.ts ?? event.timestamp;
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function reportReceivedAfterDispatch(
  record: RegistryRecord,
  name: string,
): Promise<{ received: boolean; reason?: string }> {
  const dispatchAt = record.dispatchAt ?? record.createdAt;
  const result = await execHcom([
    "events",
    "--last",
    "1000",
    "--agent",
    name,
    "--type",
    "message",
    "--after",
    dispatchAt,
  ]);
  if (result.exitCode !== 0) {
    return {
      received: false,
      reason: result.stderr || result.stdout || "hcom events returned no verification result",
    };
  }

  const dispatchMs = Date.parse(dispatchAt);
  const received = parseLifecycleEvents(result.stdout).some((event) => {
    if (event.type !== "message") return false;
    const from = event.data?.from;
    if (from !== name) return false;
    const timestamp = eventTimeMs(event);
    return timestamp === null || !Number.isFinite(dispatchMs) || timestamp >= dispatchMs;
  });
  return { received };
}

/**
 * Shared validation for stop/kill targets:
 * 1. Hub self-protection — prevents stopping/killing the calling hub agent
 * 2. Ownership check — agent must have a non-released record in this workspace
 *
 * The incoming name is canonicalized to its base form (see
 * canonicalizeAgentName) before every comparison: the registry stores base
 * names, so a tag-prefixed display name must resolve to the same record, and
 * the hub self-protection must hold against the caller's own tag-prefixed
 * form (a hub killing `w3-vade` must be refused just like `vade`).
 */
export async function validateStopKillTarget(
  name: string,
  action: "stop" | "kill" | "unblock",
  senderName?: string,
  workspace?: string,
): Promise<
  | { ok: true; cwd: string; owned: RegistryRecord; liveAgent: HcomAgent | null; canonicalName: string }
  | { ok: false; response: { content: { type: "text"; text: string }[]; isError: true } }
> {
  const cwd = workspace ?? process.cwd();

  // Hub self-protection
  const caller = await resolveCallerName(senderName);
  if (!caller) {
    return {
      ok: false,
      response: toolError(
        E_NO_SENDER,
        "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
      ),
    };
  }

  const liveAgents = await listHcomAgents();
  const canonicalName = canonicalizeAgentName(name, liveAgents);
  const liveAgent = findLiveAgentByIdentifier(canonicalName, liveAgents);

  // Self-protection compares the caller against the target's canonical base
  // name AND its live display name: a hub killing its own tag-prefixed form
  // must be refused exactly like its bare form.
  if (caller === canonicalName || caller === liveAgent?.name) {
    return {
      ok: false,
      response: toolError(E_SELF_PROTECTION, `Cannot ${action} the calling hub agent`),
    };
  }

  // Ownership check
  const records = getOwnedRecordsByWorkspace(cwd);
  const owned = records.find((r) => r.hcomName === canonicalName);

  if (!owned) {
    return {
      ok: false,
      response: liveAgent
        ? toolError(E_NOT_MANAGED, `Agent "${name}" is not managed. Use adopt tool first to take ownership.`)
        : toolError(E_AGENT_NOT_FOUND, `Agent "${name}" not found in hcom.`),
    };
  }

  return { ok: true, cwd, owned, liveAgent, canonicalName };
}

/**
 * Resolve the owned records a stop/kill call targets. Accepts explicit names
 * (canonicalized, ownership-checked individually) OR a tag (fan out over
 * owned records whose live agent carries the tag). Ownership checks are
 * never bypassed: tag fanout hits records, not live names.
 */
export async function resolveTeardownTargets(
  names: string[] | undefined,
  tag: string | undefined,
  action: "stop" | "kill",
  senderName?: string,
  workspace?: string,
): Promise<
  | {
      ok: true;
      cwd: string;
      targets: { record: RegistryRecord; liveAgent: HcomAgent | null; canonicalName: string }[];
      // Per-name validation failures (unowned/self-protection) when some
      // names resolved and others did not. Present only on partial success.
      failures?: string[];
    }
  | { ok: false; response: { content: { type: "text"; text: string }[]; isError: true } }
> {
  const cwd = workspace ?? process.cwd();

  const caller = await resolveCallerName(senderName);
  if (!caller) {
    return {
      ok: false,
      response: toolError(
        E_NO_SENDER,
        "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
      ),
    };
  }

  const liveAgents = await listHcomAgents();
  const records = getOwnedRecordsByWorkspace(cwd);

  if (tag) {
    // Tag fanout: owned records whose live agent carries the tag. The tag
    // itself is not a name — no canonicalization; hub self-protection still
    // applies per target (the caller's own agent is never in the fanout,
    // matched by base name so a tag-prefixed caller form cannot slip through).
    const callerBase = findLiveAgentByIdentifier(caller, liveAgents)?.base_name ?? caller;
    const tagged = new Set(
      liveAgents.filter((a) => a.tag === tag).map((a) => a.base_name),
    );
    const targets = records
      .filter(
        (r) =>
          r.hcomName &&
          tagged.has(r.hcomName) &&
          r.hcomName !== caller &&
          r.hcomName !== callerBase,
      )
      .map((record) => ({
        record,
        liveAgent: findLiveAgentByIdentifier(record.hcomName!, liveAgents),
        canonicalName: record.hcomName!,
      }));
    return { ok: true, cwd, targets };
  }

  if (!names || names.length === 0) {
    return {
      ok: false,
      response: toolError(E_TARGET_REQUIRED, "Provide at least one name or a tag."),
    };
  }

  // Explicit names: validate each one (ownership + self-protection) and
  // collect the failures so a partial teardown reports exactly what failed.
  const targets: { record: RegistryRecord; liveAgent: HcomAgent | null; canonicalName: string }[] = [];
  const failures: string[] = [];

  for (const name of names) {
    const validation = await validateStopKillTarget(name, action, senderName, cwd);
    if (!validation.ok) {
      failures.push(validation.response.content[0].text);
      continue;
    }
    targets.push({
      record: validation.owned,
      liveAgent: validation.liveAgent,
      canonicalName: validation.canonicalName,
    });
  }

  if (targets.length === 0) {
    return {
      ok: false,
      response: {
        content: [{ type: "text" as const, text: failures.join("\n") }],
        isError: true,
      },
    };
  }

  return { ok: true, cwd, targets, ...(failures.length > 0 ? { failures } : {}) };
}

/**
 * Execute a stop/kill fanout over resolved targets. Per-name results are
 * returned so a partial failure is visible, not swallowed.
 */
export async function runTeardown(
  targets: { record: RegistryRecord; liveAgent: HcomAgent | null; canonicalName: string }[],
  action: "stop" | "kill",
  options: { force?: boolean } = {},
): Promise<{ name: string; ok: boolean; text: string }[]> {
  const results: { name: string; ok: boolean; text: string }[] = [];

  for (const { record, liveAgent, canonicalName } of targets) {
    const isLost = record.state === "managed_lost" || record.state === "adopted_lost";
    if (isLost && !liveAgent) {
      results.push({
        name: canonicalName,
        ok: false,
        text: `[${E_AGENT_NOT_FOUND}] Agent "${canonicalName}" has a stale record but is no longer live in hcom.`,
      });
      continue;
    }

    if (record.requireReport && !options.force) {
      const report = await reportReceivedAfterDispatch(record, canonicalName);
      if (!report.received) {
        const dispatchAt = record.dispatchAt ?? record.createdAt;
        const reason = report.reason ? ` Verification failed: ${report.reason}.` : " No agent-originated message was received after dispatch.";
        results.push({
          name: canonicalName,
          ok: false,
          text: `[${E_REPORT_REQUIRED}] Refusing to ${action} agent "${canonicalName}": require_report=true.${reason} Inspect the report/transcript or retry with force=true. Dispatch: ${dispatchAt}.`,
        });
        continue;
      }
    }

    const args = action === "kill" ? ["kill", canonicalName, "--go"] : ["stop", canonicalName];
    const result = await execHcom(args);
    if (result.exitCode !== 0) {
      if ((result.stderr || result.stdout).toLowerCase().includes("not found")) {
        const lostState = record.state.startsWith("adopted_") ? "adopted_lost" : "managed_lost";
        updateRecordState(record.id, lostState);
        results.push({
          name: canonicalName,
          ok: false,
          text: `[${E_AGENT_NOT_FOUND}] Agent "${canonicalName}" is no longer live in hcom. Its record was marked ${lostState}.`,
        });
        continue;
      }
      results.push({
        name: canonicalName,
        ok: false,
        text: `[${action === "kill" ? E_KILL_FAILED : E_STOP_FAILED}] Error ${action === "kill" ? "killing" : "stopping"} agent: ${result.stderr || result.stdout}`,
      });
      continue;
    }

    const newState = record.state.startsWith("adopted_") ? "adopted_stopped" : "managed_stopped";
    updateRecordState(record.id, newState);
    const adoptedLabel = record.state.startsWith("adopted_") ? " (adopted agent)" : "";
    results.push({
      name: canonicalName,
      ok: true,
      text: `${action === "kill" ? "Killed" : "Stopped"} agent "${canonicalName}".${adoptedLabel}`,
    });
  }

  return results;
}

export function registerLifecycleTools(server: any) {
  // stop
  server.tool(
    "stop",
    "Stop (disconnect) a managed or adopted agent. Accepts one or more names, or a tag to stop every owned agent in the group. Ownership checks are never bypassed; per-name results are returned. Returns { workspace, results, stopped, failed, skipped? }. Preconditions: targets must be owned in this workspace (E_NOT_MANAGED otherwise) and must not be the calling hub agent (E_SELF_PROTECTION); sender identity required (see sender_name). Related: kill (also closes the terminal pane), adopt (take ownership first).",
    {
      names: z.array(z.string()).optional().describe("hcom agent names to stop. Provide names or tag, not both."),
      tag: z.string().optional().describe("Stop every owned agent carrying this tag (fan out over owned records only)."),
      force: z.boolean().optional().default(false).describe("Bypass only the require_report close gate; ownership and hub self-protection still apply (default: false)."),
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace); ownership records are scoped per workspace, so a mismatched workspace reports the agent as unmanaged."),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
    },
    async ({ names, tag, force, workspace, sender_name }: { names?: string[]; tag?: string; force?: boolean; workspace?: string; sender_name?: string }) => {
      const resolution = await resolveTeardownTargets(names, tag, "stop", sender_name, workspace);
      if (!resolution.ok) return resolution.response;

      const { cwd, targets, failures } = resolution;

      const results = await runTeardown(targets, "stop", { force: force ?? false });

      const payload: Record<string, unknown> = {
        workspace: cwd,
        results,
        stopped: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
      if (failures && failures.length > 0) {
        payload.skipped = failures;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        ...(results.some((r) => !r.ok) ? { isError: true as const } : {}),
      };
    }
  );

  // kill
  server.tool(
    "kill",
    "Kill a managed or adopted agent and close its terminal pane. Accepts one or more names, or a tag to kill every owned agent in the group. Ownership checks are never bypassed; per-name results are returned. Returns { workspace, results, killed, failed, skipped? }. Preconditions: targets must be owned in this workspace (E_NOT_MANAGED otherwise) and must not be the calling hub agent (E_SELF_PROTECTION); sender identity required (see sender_name). Related: stop (disconnect only), adopt (take ownership first).",
    {
      names: z.array(z.string()).optional().describe("hcom agent names to kill. Provide names or tag, not both."),
      tag: z.string().optional().describe("Kill every owned agent carrying this tag (fan out over owned records only)."),
      force: z.boolean().optional().default(false).describe("Bypass only the require_report close gate; ownership and hub self-protection still apply (default: false)."),
      workspace: z.string().optional().describe("Workspace path. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace); ownership records are scoped per workspace, so a mismatched workspace reports the agent as unmanaged."),
      sender_name: z.string().optional().describe("Sender identity used for hub self-protection. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
    },
    async ({ names, tag, force, workspace, sender_name }: { names?: string[]; tag?: string; force?: boolean; workspace?: string; sender_name?: string }) => {
      const resolution = await resolveTeardownTargets(names, tag, "kill", sender_name, workspace);
      if (!resolution.ok) return resolution.response;

      const { cwd, targets, failures } = resolution;

      const results = await runTeardown(targets, "kill", { force: force ?? false });

      const payload: Record<string, unknown> = {
        workspace: cwd,
        results,
        killed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
      if (failures && failures.length > 0) {
        payload.skipped = failures;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        ...(results.some((r) => !r.ok) ? { isError: true as const } : {}),
      };
    }
  );
}
