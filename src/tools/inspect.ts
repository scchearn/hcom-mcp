import { z } from "zod";
import { execHcom, findLiveAgentByIdentifier, listHcomAgents, parseHcomJson } from "../hcom.js";
import { getOwnedRecordsByWorkspace } from "../registry.js";

export function registerInspectTool(server: any) {
  server.tool(
    "inspect",
    "Inspect any live hcom agent: status, transcript, events, or terminal screen. Returns managementStatus (managed/adopted/unmanaged) along with inspect data.",
    {
      name: z.string().describe("hcom agent name to inspect"),
      aspect: z.enum(["status", "transcript", "events", "term"]).describe("What to inspect"),
      last: z.number().optional().describe("Last N items (for transcript/events)"),
      workspace: z.string().optional().describe("Workspace path for ownership verification"),
    },
    async ({ name, aspect, last, workspace }: {
      name: string;
      aspect: "status" | "transcript" | "events" | "term";
      last?: number;
      workspace?: string;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        // Verify agent exists in hcom
        const allAgents = await listHcomAgents();
        const liveAgent = findLiveAgentByIdentifier(name, allAgents);
        if (!liveAgent) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" not found in hcom`,
            }],
            isError: true,
          };
        }

        // Determine management status
        const records = getOwnedRecordsByWorkspace(cwd);
        const owned = records.find((r) => r.hcomName === liveAgent.name);
        let managementStatus: "managed" | "adopted" | "unmanaged";
        if (owned) {
          if (owned.state.startsWith("adopted_") || owned.preset === "adopted") {
            managementStatus = "adopted";
          } else {
            managementStatus = "managed";
          }
        } else {
          managementStatus = "unmanaged";
        }

        let result;

        switch (aspect) {
          case "status": {
            const hcomResult = await execHcom(["list", name, "--json"]);
            if (hcomResult.exitCode !== 0) {
              throw new Error(`hcom list failed: ${hcomResult.stderr}`);
            }
            result = parseHcomJson(hcomResult.stdout);
            break;
          }

          case "transcript": {
            const n = last ?? 10;
            const hcomResult = await execHcom(["transcript", name, `--last=${n}`]);
            if (hcomResult.exitCode !== 0) {
              throw new Error(`hcom transcript failed: ${hcomResult.stderr}`);
            }
            result = hcomResult.stdout;
            break;
          }

          case "events": {
            const n = last ?? 20;
            const hcomResult = await execHcom(["events", "--last", String(n), "--agent", name, "--json"]);
            if (hcomResult.exitCode !== 0) {
              // events --json might not exist, fall back to plain output
              const fallback = await execHcom(["events", "--last", String(n), "--agent", name]);
              result = fallback.stdout;
            } else {
              result = parseHcomJson(hcomResult.stdout);
            }
            break;
          }

          case "term": {
            const hcomResult = await execHcom(["term", name, "--json"]);
            if (hcomResult.exitCode !== 0) {
              throw new Error(`hcom term failed: ${hcomResult.stderr}`);
            }
            result = parseHcomJson(hcomResult.stdout) ?? hcomResult.stdout;
            break;
          }
        }

        const responsePayload = {
          agent: liveAgent.name,
          managementStatus,
          inspect: result,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(responsePayload, null, 2),
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
