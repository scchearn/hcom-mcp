import { z } from "zod";
import {
  canonicalizeAgentName,
  execHcom,
  findLiveAgentByIdentifier,
  listHcomAgents,
  parseHcomJson,
} from "../hcom.js";
import { getOwnedRecordsByWorkspace } from "../registry.js";
import { E_AGENT_NOT_FOUND, E_INTERNAL, internalError, toolError } from "../errors.js";

export function registerInspectTool(server: any) {
  server.tool(
    "inspect",
    "Inspect any live hcom agent: status, transcript, events, or terminal screen. Returns { agent, managementStatus (managed/adopted/unmanaged), inspect } where inspect is the per-aspect payload (status: agent JSON; transcript: text; events: parsed event array; term: parsed screen). Precondition: the agent must be live in hcom (E_AGENT_NOT_FOUND otherwise). Read-only; no sender identity required. Related: list_all (discover agents), transcript (richer reads).",
    {
      name: z.string().describe("hcom agent name to inspect"),
      aspect: z.enum(["status", "transcript", "events", "term"]).describe("What to inspect"),
      last: z.number().optional().describe("Last N items (for transcript/events)"),
      workspace: z.string().optional().describe("Workspace path for ownership verification. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace); ownership records are scoped per workspace."),
    },
    async ({ name, aspect, last, workspace }: {
      name: string;
      aspect: "status" | "transcript" | "events" | "term";
      last?: number;
      workspace?: string;
    }) => {
      const cwd = workspace ?? process.cwd();

      try {
        // Verify agent exists in hcom, canonicalizing the incoming name so a
        // tag-prefixed display name resolves to the same live agent and record.
        const allAgents = await listHcomAgents();
        const canonicalName = canonicalizeAgentName(name, allAgents);
        const liveAgent = findLiveAgentByIdentifier(canonicalName, allAgents);
        if (!liveAgent) {
          return toolError(E_AGENT_NOT_FOUND, `Agent "${name}" not found in hcom`);
        }

        // Determine management status
        const records = getOwnedRecordsByWorkspace(cwd);
        const owned = records.find((r) => r.hcomName === canonicalName);
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
            const hcomResult = await execHcom(["list", canonicalName, "--json"]);
            if (hcomResult.exitCode !== 0) {
              throw new Error(`hcom list failed: ${hcomResult.stderr}`);
            }
            result = parseHcomJson(hcomResult.stdout);
            break;
          }

          case "transcript": {
            const n = last ?? 10;
            const hcomResult = await execHcom(["transcript", canonicalName, `--last=${n}`]);
            if (hcomResult.exitCode !== 0) {
              throw new Error(`hcom transcript failed: ${hcomResult.stderr}`);
            }
            result = hcomResult.stdout;
            break;
          }

          case "events": {
            const n = last ?? 20;
            // hcom events emits NDJSON by default; there is no --json flag.
            // Parse each line exactly like thread_inspect does.
            const hcomResult = await execHcom(["events", "--last", String(n), "--agent", canonicalName]);
            if (hcomResult.exitCode !== 0) {
              throw new Error(`hcom events failed: ${hcomResult.stderr}`);
            }
            result = hcomResult.stdout
              .split("\n")
              .filter((line: string) => line.trim())
              .map((line: string) => parseHcomJson(line))
              .filter(Boolean);
            break;
          }

          case "term": {
            const hcomResult = await execHcom(["term", canonicalName, "--json"]);
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
        return internalError(err);
      }
    }
  );
}
