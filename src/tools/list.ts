import { z } from "zod";
import { execHcom, parseHcomJson } from "../hcom.js";
import { getActiveRecords } from "../registry.js";
import type { HcomAgent } from "../types.js";

export function registerListManagedTool(server: any) {
  server.tool(
    "hcom_list_managed",
    "List all hcom agents managed by this MCP server in the current workspace",
    {
      workspace: z.string().optional().describe("Workspace path"),
    },
    async ({ workspace }: { workspace?: string }) => {
      const cwd = workspace ?? process.cwd();

      try {
        const records = getActiveRecords(cwd);

        // Also get current hcom state to enrich
        const hcomResult = await execHcom(["list", "--json"]);
        let hcomAgents: HcomAgent[] = [];
        if (hcomResult.exitCode === 0) {
          hcomAgents = parseHcomJson<HcomAgent[]>(hcomResult.stdout) ?? [];
        }

        // Enrich records with live status
        const enriched = records.map((record) => {
          const liveAgent = hcomAgents.find((a) => a.name === record.hcomName);
          return {
            ...record,
            liveStatus: liveAgent?.status ?? "unknown",
            liveDescription: liveAgent?.description ?? null,
            liveTool: liveAgent?.tool ?? null,
          };
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ managed: enriched, total: enriched.length }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}