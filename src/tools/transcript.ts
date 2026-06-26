import { z } from "zod";
import {
  execHcom,
  findLiveAgentByIdentifier,
  listHcomAgents,
  parseHcomJson,
} from "../hcom.js";

const TranscriptModeEnum = z.enum(["read", "search", "timeline"]);
const TranscriptAgentTypeEnum = z.enum([
  "claude",
  "gemini",
  "codex",
  "opencode",
  "kilo",
  "pi",
  "antigravity",
  "cursor",
  "kimi",
  "copilot",
]);

export function registerTranscriptTool(server: any) {
  server.tool(
    "transcript",
    "Read hcom transcripts. Supports per-agent transcript reads (including range/full/detailed), cross-agent transcript search, and timeline view.",
    {
      mode: TranscriptModeEnum.describe("Operation: read one agent transcript, search transcripts, or view the timeline"),
      name: z.string().optional().describe("Agent name for read mode"),
      range: z.string().optional().describe("Exchange number or range for read mode, e.g. '7' or '7-10'"),
      last: z.number().optional().describe("Limit number of exchanges/items (default: 10)"),
      full: z.boolean().optional().describe("Show complete assistant responses when supported"),
      detailed: z.boolean().optional().describe("Include tool I/O, file edits, and errors when supported"),
      pattern: z.string().optional().describe("Search pattern for search mode"),
      live: z.boolean().optional().describe("Search only currently alive agents"),
      all: z.boolean().optional().describe("Search all transcripts, including non-hcom sessions"),
      limit: z.number().optional().describe("Maximum search results (default: 20)"),
      agent_type: TranscriptAgentTypeEnum.optional().describe("Filter search results by agent type"),
      exclude_self: z.boolean().optional().describe("Exclude the searching agent's own transcript in search mode"),
    },
    async ({
      mode,
      name,
      range,
      last,
      full,
      detailed,
      pattern,
      live,
      all,
      limit,
      agent_type,
      exclude_self,
    }: {
      mode: "read" | "search" | "timeline";
      name?: string;
      range?: string;
      last?: number;
      full?: boolean;
      detailed?: boolean;
      pattern?: string;
      live?: boolean;
      all?: boolean;
      limit?: number;
      agent_type?: z.infer<typeof TranscriptAgentTypeEnum>;
      exclude_self?: boolean;
    }) => {
      try {
        if (mode === "read") {
          if (!name) {
            return {
              content: [{ type: "text" as const, text: "Error: name is required for transcript read mode" }],
              isError: true,
            };
          }

          const agents = await listHcomAgents();
          const liveAgent = findLiveAgentByIdentifier(name, agents);
          if (!liveAgent) {
            return {
              content: [{ type: "text" as const, text: `Error: Agent "${name}" not found in hcom` }],
              isError: true,
            };
          }

          const args = ["transcript", liveAgent.name];
          if (range) {
            args.push(range);
          } else if (last !== undefined) {
            args.push("--last", String(last));
          }
          if (full) args.push("--full");
          if (detailed) args.push("--detailed");
          args.push("--json");

          const result = await execHcom(args);
          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text" as const, text: `Error reading transcript: ${result.stderr || result.stdout}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  mode,
                  agent: liveAgent.name,
                  transcript: parseHcomJson(result.stdout) ?? result.stdout,
                },
                null,
                2,
              ),
            }],
          };
        }

        if (mode === "search") {
          if (!pattern) {
            return {
              content: [{ type: "text" as const, text: "Error: pattern is required for transcript search mode" }],
              isError: true,
            };
          }

          const args = ["transcript", "search", pattern];
          if (live) args.push("--live");
          if (all) args.push("--all");
          if (limit !== undefined) args.push("--limit", String(limit));
          if (agent_type) args.push("--agent", agent_type);
          if (exclude_self) args.push("--exclude-self");
          args.push("--json");

          const result = await execHcom(args);
          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text" as const, text: `Error searching transcripts: ${result.stderr || result.stdout}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  mode,
                  result: parseHcomJson(result.stdout) ?? result.stdout,
                },
                null,
                2,
              ),
            }],
          };
        }

        const args = ["transcript", "timeline"];
        if (last !== undefined) args.push("--last", String(last));
        if (full) args.push("--full");
        if (detailed) args.push("--detailed");
        args.push("--json");

        const result = await execHcom(args);
        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text" as const, text: `Error reading transcript timeline: ${result.stderr || result.stdout}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                mode,
                transcript: parseHcomJson(result.stdout) ?? result.stdout,
              },
              null,
              2,
            ),
          }],
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
