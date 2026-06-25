import { z } from "zod";
import { pruneRecords } from "../registry.js";

export function registerPruneTool(server: any) {
  server.tool(
    "prune",
    "Remove stale registry records for workspace. By default, targets managed_lost and adopted_lost records older than 7 days (dry-run only). Use confirm=true to actually remove records. Use includeStopped=true to also target managed_stopped and adopted_stopped records older than 30 days.",
    {
      workspace: z.string().optional().describe("Workspace path (defaults to current directory)"),
      olderThanDays: z.number().default(7).describe("Minimum age in days for lost records to be pruned"),
      includeStopped: z.boolean().default(false).describe("Also target stopped records (managed_stopped, adopted_stopped)"),
      stoppedOlderThanDays: z.number().default(30).describe("Minimum age in days for stopped records to be pruned"),
      confirm: z.boolean().default(false).describe("Set to true to actually remove records (default is dry-run)"),
    },
    async ({
      workspace,
      olderThanDays,
      includeStopped,
      stoppedOlderThanDays,
      confirm,
    }: {
      workspace?: string;
      olderThanDays: number;
      includeStopped: boolean;
      stoppedOlderThanDays: number;
      confirm: boolean;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const result = pruneRecords(cwd, {
          olderThanDays,
          includeStopped,
          stoppedOlderThanDays,
          confirm,
        });

        if (!confirm) {
          const records = result.wouldRemove;
          const stateBreakdown: Record<string, number> = {};
          for (const r of records) {
            stateBreakdown[r.state] = (stateBreakdown[r.state] ?? 0) + 1;
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    dryRun: true,
                    message: `Would remove ${records.length} record(s) (use confirm=true to execute)`,
                    count: records.length,
                    stateBreakdown,
                    names: records.map((r) => r.hcomName ?? r.id),
                    records,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const records = result.removed;
        const stateBreakdown: Record<string, number> = {};
        for (const r of records) {
          stateBreakdown[r.state] = (stateBreakdown[r.state] ?? 0) + 1;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  dryRun: false,
                  message: `Removed ${records.length} record(s)`,
                  count: records.length,
                  stateBreakdown,
                  names: records.map((r) => r.hcomName ?? r.id),
                  records,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
