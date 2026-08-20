import { z } from "zod";
import { execHcom, parseHcomJson } from "../hcom.js";
import { E_BUNDLE_FAILED, E_NAME_REQUIRED, toolError } from "../errors.js";

export function registerContinueFromTool(server: any) {
  server.tool(
    "continue_from",
    "Get handoff context from a previous agent — recent transcript, events, and files — to continue where the named agent left off. Works for live and stopped agents; you phrase the continuation. Read-only, launches/mutates nothing; no sender identity required. Related: resume (continue the session), fork (branch it).",
    {
      name: z.string().min(1).describe("Agent name to pull handoff context for. @ prefix is accepted and stripped. Bare names work for live and stopped agents; tag-names work only for live agents (upstream hcom limit)."),
      last_transcript: z.number().int().positive().default(40).describe("Number of transcript exchanges to include. Passed through to hcom bundle prepare."),
      last_events: z.number().int().positive().default(10).describe("Events scanned per category. hcom hard-caps the lifecycle category at 5."),
      compact: z.boolean().optional().describe("Hide the how-to section of the bundle (default: false)"),
    },
    async ({
      name,
      last_transcript,
      last_events,
      compact,
    }: {
      name: string;
      last_transcript: number;
      last_events: number;
      compact?: boolean;
    }) => {
      try {
        const normalizedName = name.startsWith("@") ? name.slice(1) : name;
        if (!normalizedName) {
          return toolError(E_NAME_REQUIRED, "name is required");
        }

        const args = [
          "bundle",
          "prepare",
          "--for",
          normalizedName,
          "--last-transcript",
          String(last_transcript ?? 40),
          "--last-events",
          String(last_events ?? 10),
        ];
        if (compact) args.push("--compact");
        args.push("--json");

        const result = await execHcom(args);

        if (result.exitCode !== 0) {
          return toolError(
            E_BUNDLE_FAILED,
            `Error preparing bundle: ${result.stderr || result.stdout}`,
          );
        }

        const bundle = parseHcomJson(result.stdout);

        if (bundle === null) {
          return toolError(
            E_BUNDLE_FAILED,
            `Error preparing bundle: hcom returned non-JSON output: ${result.stdout.slice(0, 200)}`,
          );
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(bundle, null, 2),
          }],
        };
      } catch (err: any) {
        return toolError(E_BUNDLE_FAILED, err.message);
      }
    },
  );
}
