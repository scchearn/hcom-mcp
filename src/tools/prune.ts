import { z } from "zod";
import { execHcom } from "../hcom.js";
import { pruneRecords } from "../registry.js";
import { E_INTERNAL, E_PRUNE_KILL_FAILED, internalError, toolError } from "../errors.js";

export function registerPruneTool(server: any) {
  server.tool(
    "prune",
    "Remove stale registry records. Reconciles against live hcom state first (never-live records are demoted to lost where the age rules can reach them), then applies the age rules. By default targets managed_lost and adopted_lost records older than 7 days (dry-run only). Use confirm=true to actually remove records. Use include_stopped=true to also target managed_stopped and adopted_stopped records older than 30 days. Use expired=true to target expired ephemeral records (ttl_minutes launches): kills the agents and clears their records. Use all_workspaces=true to prune every workspace in one call instead of one call per workspace. Returns { dryRun, message, count, stateBreakdown, names, killed? } plus records when verbose=true. Read-only (dry-run) by default; no sender identity required. Related: status (record counts), list_managed.",
    {
      workspace: z.string().optional().describe("Workspace path (defaults to the server's working directory; pass explicitly when the server runs under a service manager so records are scoped to the workspace you query with list_managed). Ignored when all_workspaces=true."),
      olderThanDays: z.number().optional().describe("DEPRECATED alias for lostOlderThanDays (kept for one release; use lostOlderThanDays)"),
      lostOlderThanDays: z.number().optional().describe("Minimum age in days for lost records to be pruned (default: 7)"),
      includeStopped: z.boolean().default(false).describe("Also target stopped records (managed_stopped, adopted_stopped)"),
      stoppedOlderThanDays: z.number().default(30).describe("Minimum age in days for stopped records to be pruned"),
      confirm: z.boolean().default(false).describe("Set to true to actually remove records (default is dry-run)"),
      allWorkspaces: z.boolean().default(false).describe("DEPRECATED camelCase alias for all_workspaces (kept for one release; use all_workspaces)"),
      all_workspaces: z.boolean().default(false).describe("Prune records across all workspaces in one call (default: only the given workspace)"),
      expired: z.boolean().default(false).describe("Target expired ephemeral records (ttl_minutes launches): kill the agents and clear their records"),
      verbose: z.boolean().default(false).describe("Include the full removed records in the response (default: summary only)"),
    },
    async ({
      workspace,
      lostOlderThanDays,
      olderThanDays,
      includeStopped,
      stoppedOlderThanDays,
      confirm,
      allWorkspaces,
      all_workspaces,
      expired,
      verbose,
    }: {
      workspace?: string;
      lostOlderThanDays?: number;
      olderThanDays?: number;
      includeStopped: boolean;
      stoppedOlderThanDays: number;
      confirm: boolean;
      allWorkspaces: boolean;
      all_workspaces: boolean;
      expired: boolean;
      verbose: boolean;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        // The canonical name wins; the deprecated alias is a fallback. Both
        // are zod-optional so the registry-level default (7) applies when
        // neither is passed.
        const effectiveLostOlderThanDays = lostOlderThanDays ?? olderThanDays;
        // all_workspaces is the canonical name; the camelCase alias is kept
        // for one release. The explicit || false mirrors the zod defaults for
        // direct handler invocation.
        const effectiveAllWorkspaces = all_workspaces || allWorkspaces || false;

        // Expired mode kills the agents before clearing their records.
        if (expired && confirm) {
          const result = await pruneRecords(cwd, {
            lostOlderThanDays: effectiveLostOlderThanDays,
            includeStopped,
            stoppedOlderThanDays,
            confirm: false,
            allWorkspaces: effectiveAllWorkspaces,
            expired: true,
          });
          const killTargets = result.wouldRemove
            .filter((r) => r.hcomName)
            .map((r) => r.hcomName!);
          const failedKills: string[] = [];
          for (const name of killTargets) {
            const kill = await execHcom(["kill", name, "--go"]);
            const msg = (kill.stderr || kill.stdout).toLowerCase();
            // "not found" means the agent already exited on its own — safe to
            // clear. Any other failure leaves the agent alive, so its record
            // must NOT be cleared (no orphaned live agents).
            if (kill.exitCode !== 0 && !msg.includes("not found")) {
              failedKills.push(name);
            }
          }
          if (failedKills.length > 0) {
            return toolError(
              E_PRUNE_KILL_FAILED,
              `failed to kill ${failedKills.join(", ")} before clearing records. ` +
                `No records were removed; retry after confirming the agents are gone.`,
            );
          }
          const confirmed = await pruneRecords(cwd, {
            lostOlderThanDays: effectiveLostOlderThanDays,
            includeStopped,
            stoppedOlderThanDays,
            confirm: true,
            allWorkspaces: effectiveAllWorkspaces,
            expired: true,
          });
          return summarize(confirmed.removed, true, verbose, {
            killed: killTargets,
          });
        }

        const result = await pruneRecords(cwd, {
          lostOlderThanDays: effectiveLostOlderThanDays,
          includeStopped,
          stoppedOlderThanDays,
          confirm,
          allWorkspaces: effectiveAllWorkspaces,
          expired,
        });

        if (!confirm) {
          return summarize(result.wouldRemove, false, verbose);
        }

        return summarize(result.removed, true, verbose);
      } catch (err: any) {
        return internalError(err);
      }
    },
  );
}

function summarize(
  records: any[],
  confirmed: boolean,
  verbose: boolean,
  extra: Record<string, unknown> = {},
) {
  const stateBreakdown: Record<string, number> = {};
  for (const r of records) {
    stateBreakdown[r.state] = (stateBreakdown[r.state] ?? 0) + 1;
  }

  const payload: Record<string, unknown> = {
    dryRun: !confirmed,
    message: confirmed
      ? `Removed ${records.length} record(s)`
      : `Would remove ${records.length} record(s) (use confirm=true to execute)`,
    count: records.length,
    stateBreakdown,
    names: records.map((r) => r.hcomName ?? r.id),
    ...extra,
  };

  // Full record dumps are opt-in: the default summary stays usable even with
  // thousands of stale records.
  if (verbose) {
    payload.records = records;
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
