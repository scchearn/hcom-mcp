import { z } from "zod";
import * as registry from "../registry.js";
import { runTeardown } from "./lifecycle.js";
import { E_INTERNAL, E_PRUNE_KILL_FAILED, internalError, toolError } from "../errors.js";

const { pruneRecords, removeRecords } = registry;

export function registerPruneTool(server: any) {
  server.tool(
    "prune",
    "Remove stale registry records. Reconciles against live hcom first (never-live records demoted to lost within reach of the age rules), then applies age rules. Default: managed/adopted_lost older than 7 days, dry-run — use confirm=true to remove. include_stopped=true also targets managed/adopted_stopped older than 30 days. expired=true kills and clears expired ephemeral (ttl_minutes) records. all_workspaces=true prunes every workspace in one call. Dry-run by default; no sender identity required. Related: status (record counts), list_managed.",
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
      force: z.boolean().default(false).describe("Bypass report-required teardown gates when intentionally clearing expired records"),
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
      force,
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
      force: boolean;
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

        // Expired mode kills the agents through the same guarded teardown path
        // as stop/kill, then clears only records whose kill succeeded.
        if (expired && confirm) {
          const result = await pruneRecords(cwd, {
            lostOlderThanDays: effectiveLostOlderThanDays,
            includeStopped,
            stoppedOlderThanDays,
            confirm: false,
            allWorkspaces: effectiveAllWorkspaces,
            expired: true,
          });
          const teardown = await runTeardown(
            result.wouldRemove.map((record) => ({
              record,
              liveAgent: null,
              canonicalName: record.hcomName ?? record.id,
            })),
            "kill",
            { force: force ?? false, updateState: false, allowMissing: true },
          );
          const failedTeardown = teardown.filter((entry) => !entry.ok);
          const reportSkips = failedTeardown
            .filter((entry) => entry.text.includes("E_REPORT_REQUIRED"))
            .map((entry) => entry.text);
          if (reportSkips.length > 0) {
            return {
              isError: true,
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  dryRun: false,
                  message: "No records were removed because report-required teardown was refused",
                  count: 0,
                  stateBreakdown: {},
                  names: [],
                  skipped: reportSkips,
                  teardown,
                }, null, 2),
              }],
            };
          }
          if (failedTeardown.length > 0) {
            const failedKills = failedTeardown.map((entry) => entry.name);
            return toolError(
              E_PRUNE_KILL_FAILED,
              `failed to kill ${failedKills.join(", ")} before clearing records. ` +
                `No records were removed; retry after confirming the agents are gone.`,
            );
          }
          removeRecords(result.wouldRemove.map((record) => record.id));
          return summarize(result.wouldRemove, true, verbose, {
            killed: teardown.filter((entry) => entry.ok).map((entry) => entry.name),
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
