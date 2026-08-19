import { z } from "zod";
import { execHcom, resolveCallerName } from "../hcom.js";
import { addRecord } from "../registry.js";
import { HarnessEnum } from "../types.js";
import type { Harness } from "../types.js";

/**
 * Parse the agent name from hcom r / hcom f output. Both print
 * "Names: <name>" on stdout (same contract as launch); resume also prints
 * "Resumed <name>". Returns null when no name could be parsed.
 */
function parseSpawnedName(stdout: string): string | null {
  const namesMatch = stdout.match(/Names:\s+(\S+)/);
  if (namesMatch) return namesMatch[1];
  const resumedMatch = stdout.match(/Resumed\s+(\S+)/);
  if (resumedMatch) return resumedMatch[1];
  return null;
}

/**
 * Shared resume/fork flow: run the hcom command, register a new ownership
 * record with a resumedFrom link to the source agent, and report.
 */
async function runResumeFork(
  kind: "resume" | "fork",
  target: string,
  options: {
    workspace?: string;
    sender_name?: string;
    tag?: string;
    dir?: string;
    headless?: boolean;
    prompt?: string;
    harness?: Harness;
    go?: boolean;
  },
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
  const cwd = options.workspace ?? process.cwd();

  const caller = await resolveCallerName(options.sender_name);
  if (!caller) {
    return {
      content: [{
        type: "text" as const,
        text: "Error: Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
      }],
      isError: true,
    };
  }

  const args = [kind === "resume" ? "r" : "f", target];
  if (options.tag) args.push("--tag", options.tag);
  if (options.dir) args.push("--dir", options.dir);
  if (options.headless) args.push("--headless");
  if (options.prompt) args.push("--hcom-prompt", options.prompt);
  if (options.go) args.push("--go");

  const result = await execHcom(args);
  if (result.exitCode !== 0) {
    return {
      content: [{
        type: "text" as const,
        text: `Error ${kind === "resume" ? "resuming" : "forking"} agent: ${result.stderr || result.stdout}`,
      }],
      isError: true,
    };
  }

  const spawnedName = parseSpawnedName(result.stdout);
  if (!spawnedName) {
    return {
      content: [{
        type: "text" as const,
        text: `Error: hcom ${kind} succeeded but no agent name could be parsed from its output. No record was registered. Output: ${result.stdout.slice(0, 200)}`,
      }],
      isError: true,
    };
  }

  // Register ownership. The harness is the caller's best knowledge; the
  // record is still useful for stop/kill/list_managed even if the harness
  // guess is wrong (it only feeds display and adopt-style inference).
  const record = addRecord({
    workspace: cwd,
    harness: options.harness ?? "opencode",
    hcomName: spawnedName,
    preset: kind,
    launchMode: options.headless ? "headless" : "headed",
    state: "managed_active",
    released: false,
    launchedBy: caller,
    resumedFrom: target,
  });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(
        {
          kind,
          target,
          spawnedName,
          registryId: record.id,
          resumedFrom: target,
          command: `hcom ${args.join(" ")}`,
        },
        null,
        2,
      ),
    }],
  };
}

export function registerResumeForkTools(server: any) {
  server.tool(
    "resume",
    "Resume a stopped agent (hcom r). Registers a new ownership record with a resumedFrom link to the source agent, completing the continue_from handoff story. The source agent's identity is reclaimed when hcom supports it.",
    {
      name: z.string().describe("Target: hcom name, session UUID, ses_<id>, or thread name."),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      tag: z.string().optional().describe("Group tag for the resumed agent (names become tag-*)."),
      dir: z.string().optional().describe("Working directory override."),
      headless: z.boolean().optional().describe("Run in background (default: true)."),
      prompt: z.string().optional().describe("Initial prompt for the resumed agent."),
      harness: HarnessEnum.optional().describe("Harness recorded on the ownership record (display only; hcom infers the real harness from the target)."),
      go: z.boolean().optional().describe("Skip preview, run immediately (default: true)."),
    },
    async ({ name, workspace, sender_name, tag, dir, headless, prompt, harness, go }: {
      name: string;
      workspace?: string;
      sender_name?: string;
      tag?: string;
      dir?: string;
      headless?: boolean;
      prompt?: string;
      harness?: Harness;
      go?: boolean;
    }) => {
      try {
        return await runResumeFork("resume", name, {
          workspace,
          sender_name,
          tag,
          dir,
          headless: headless ?? true,
          prompt,
          harness,
          go: go ?? true,
        });
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "fork",
    "Fork an agent session (hcom f): creates a new agent that continues from the forked session. Registers a new ownership record with a resumedFrom link to the source agent.",
    {
      name: z.string().describe("Target: hcom name, session UUID, ses_<id>, or thread name."),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. Required for HTTP or unbound MCP callers when auto-resolution is unavailable."),
      tag: z.string().optional().describe("Group tag for the forked agent (names become tag-*)."),
      dir: z.string().optional().describe("Working directory override. Required for remote forks."),
      headless: z.boolean().optional().describe("Run in background (default: true)."),
      prompt: z.string().optional().describe("Initial prompt for the forked agent."),
      harness: HarnessEnum.optional().describe("Harness recorded on the ownership record (display only; hcom infers the real harness from the target)."),
      go: z.boolean().optional().describe("Skip preview, run immediately (default: true)."),
    },
    async ({ name, workspace, sender_name, tag, dir, headless, prompt, harness, go }: {
      name: string;
      workspace?: string;
      sender_name?: string;
      tag?: string;
      dir?: string;
      headless?: boolean;
      prompt?: string;
      harness?: Harness;
      go?: boolean;
    }) => {
      try {
        return await runResumeFork("fork", name, {
          workspace,
          sender_name,
          tag,
          dir,
          headless: headless ?? true,
          prompt,
          harness,
          go: go ?? true,
        });
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
