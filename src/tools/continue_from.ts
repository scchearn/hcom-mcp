import { z } from "zod";
import { execHcom, parseHcomJson } from "../hcom.js";

export function registerContinueFromTool(server: any) {
  server.tool(
    "continue_from",
    "Get handoff context from a previous agent's work — recent transcript, events, and files — so you can continue from where the named agent left off. Works for live and stopped agents. Returns the bundle as JSON; you decide how to phrase the continuation. The tool does not launch or mutate anything.",
    {
      name: z.string().min(1).describe("Agent name to pull handoff context for. @ prefix is accepted and stripped. Bare names work for live and stopped agents; tag-names work only for live agents (upstream hcom limit)."),
      last_transcript: z.number().int().positive().default(40).describe("Number of transcript exchanges to include. Passed through to hcom bundle prepare."),
      last_events: z.number().int().positive().default(10).describe("Events scanned per category. hcom hard-caps the lifecycle category at 5."),
    },
    async ({
      name,
      last_transcript,
      last_events,
    }: {
      name: string;
      last_transcript: number;
      last_events: number;
    }) => {
      try {
        const normalizedName = name.startsWith("@") ? name.slice(1) : name;
        if (!normalizedName) {
          return {
            content: [{ type: "text" as const, text: "Error: name is required" }],
            isError: true,
          };
        }

        const result = await execHcom([
          "bundle",
          "prepare",
          "--for",
          normalizedName,
          "--last-transcript",
          String(last_transcript ?? 40),
          "--last-events",
          String(last_events ?? 10),
          "--json",
        ]);

        if (result.exitCode !== 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Error preparing bundle: ${result.stderr || result.stdout}`,
            }],
            isError: true,
          };
        }

        const bundle = parseHcomJson(result.stdout);

        if (bundle === null) {
          return {
            content: [{
              type: "text" as const,
              text: `Error preparing bundle: hcom returned non-JSON output: ${result.stdout.slice(0, 200)}`,
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(bundle, null, 2),
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
