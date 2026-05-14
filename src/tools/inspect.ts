import { z } from "zod";
import { execHcom, parseHcomJson } from "../hcom.js";
import { getActiveRecords } from "../registry.js";

export function registerInspectTool(server: any) {
  server.tool(
    "hcom_inspect",
    "Inspect a managed agent: status, transcript, events, or terminal screen",
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
        // Verify ownership
        const records = getActiveRecords(cwd);
        const owned = records.find((r) => r.hcomName === name);
        if (!owned) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: Agent "${name}" is not managed by this server in workspace "${cwd}". Managed agents: ${records.map((r) => r.hcomName).join(", ")}`,
            }],
            isError: true,
          };
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

        return {
          content: [{
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
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