import { z } from "zod";
import { execCommand, execHcom, resolveCallerName } from "../hcom.js";
import { addRecord, getOwnedRecordsByWorkspace, upsertResumedRecord } from "../registry.js";
import { HarnessEnum } from "../types.js";
import type { Harness, RegistryRecord } from "../types.js";
import {
  E_INTERNAL,
  E_LAUNCH_FAILED,
  E_NO_SENDER,
  E_RESUME_INCONCLUSIVE,
  E_RESUME_UNSUPPORTED,
  internalError,
  toolError,
} from "../errors.js";
import {
  eventBelongsTo,
  eventData,
  eventTimeMs,
  isAgentMessageEvent,
  newestEvent,
  parseHcomEvents,
  type HcomEvent,
} from "../events.js";

const RESUME_CONSUMPTION_TIMEOUT_SEC = 60;
const RESUME_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000;
const OPEN_CODE_SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;
const DEFAULT_OPEN_CODE_RESUME_PROMPT =
  "Continue from the current session and process any pending hcom messages.";

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

interface StoppedAgentSnapshot {
  name?: string;
  tool?: string;
  directory?: string;
  sessionId?: string;
}

interface ResumeSource {
  record?: RegistryRecord;
  hcomName?: string;
  sessionId?: string;
  tool?: string;
  directory?: string;
}

function parseStoppedAgentSnapshot(stdout: string): StoppedAgentSnapshot {
  const snapshot: StoppedAgentSnapshot = {};
  for (const line of stdout.split("\n")) {
    const field = line.match(/^\s*(Stopped|Tool|Directory|Session):\s*(.+?)\s*$/);
    if (!field) continue;
    const value = field[2];
    if (field[1] === "Stopped") snapshot.name = value;
    if (field[1] === "Tool") snapshot.tool = value;
    if (field[1] === "Directory") snapshot.directory = value;
    if (field[1] === "Session") snapshot.sessionId = value;
  }
  return snapshot;
}

function isRetainedOpenCodeSessionId(value: string | undefined): value is string {
  return Boolean(value && OPEN_CODE_SESSION_ID.test(value));
}

function eventId(event: HcomEvent): number {
  return typeof event.id === "number" && Number.isFinite(event.id) ? event.id : 0;
}

function eventValue(event: HcomEvent, key: string): unknown {
  return eventData(event)[key];
}

function eventIsAfter(event: HcomEvent, baselineId: number, startedAtMs: number): boolean {
  const id = eventId(event);
  if (id > 0 && baselineId > 0) return id > baselineId;
  const timestamp = eventTimeMs(event);
  return timestamp !== null && timestamp >= startedAtMs;
}

function hasHcomConsumptionEvidence(
  events: HcomEvent[],
  name: string,
  baselineId: number,
  startedAtMs: number,
): boolean {
  return events.some((event) => {
    if (!eventBelongsTo(event, name) || !eventIsAfter(event, baselineId, startedAtMs)) {
      return false;
    }
    if (event.type === "message") return isAgentMessageEvent(event, name);
    if (event.type !== "status") return false;
    return eventValue(event, "status") === "active" || eventValue(event, "val") === "active";
  });
}

function hasOpenCodeResponseEvidence(stdout: string, sessionId: string): boolean {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (event.sessionID !== sessionId) return false;
      if (event.type === "text") {
        const part = event.part;
        return Boolean(
          part &&
          typeof part === "object" &&
          typeof (part as Record<string, unknown>).text === "string" &&
          ((part as Record<string, unknown>).text as string).trim(),
        );
      }
      return event.type === "step_finish" || event.type === "tool_use";
    });
}

async function lastHcomEventId(name: string, execHcomFn: typeof execHcom): Promise<number> {
  const result = await execHcomFn(["events", "--last", "1", "--agent", name]);
  if (result.exitCode !== 0) return 0;
  return Math.max(...parseHcomEvents(result.stdout).map(eventId), 0);
}

async function verifyResumeConsumption(
  name: string,
  baselineId: number,
  startedAtMs: number,
  execHcomFn: typeof execHcom,
): Promise<{ ok: boolean; evidence?: string; reason?: string }> {
  const recent = await execHcomFn(["events", "--last", "100", "--agent", name]);
  if (recent.exitCode === 0) {
    const events = parseHcomEvents(recent.stdout);
    const active = events.some(
      (event) =>
        eventBelongsTo(event, name) &&
        eventIsAfter(event, baselineId, startedAtMs) &&
        event.type === "status" &&
        (eventValue(event, "status") === "active" || eventValue(event, "val") === "active"),
    );
    if (active) return { ok: true, evidence: "hcom status active" };
    if (hasHcomConsumptionEvidence(events, name, baselineId, startedAtMs)) {
      return { ok: true, evidence: "hcom agent response" };
    }
  }

  const waited = await execHcomFn(
    ["events", "--wait", String(RESUME_CONSUMPTION_TIMEOUT_SEC), "--agent", name, "--status", "active"],
    { timeoutMs: (RESUME_CONSUMPTION_TIMEOUT_SEC + 10) * 1000 },
  );
  if (waited.exitCode === 0) {
    const events = parseHcomEvents(waited.stdout);
    if (hasHcomConsumptionEvidence(events, name, baselineId, startedAtMs)) {
      return { ok: true, evidence: "hcom status active" };
    }
  }

  return {
    ok: false,
    reason:
      `Could not prove that the resumed agent consumed its queued turn within ${RESUME_CONSUMPTION_TIMEOUT_SEC} seconds. ` +
      "Inspect its terminal and transcript before retrying.",
  };
}

async function verifyResumeReport(
  name: string,
  baselineId: number,
  startedAtMs: number,
  execHcomFn: typeof execHcom,
): Promise<{ ok: boolean; evidence?: string; reportId?: number; reason?: string }> {
  const result = await execHcomFn(["events", "--last", "100", "--type", "message", "--agent", name]);
  if (result.exitCode === 0) {
    const report = newestEvent(
      parseHcomEvents(result.stdout).filter(
        (event) =>
          isAgentMessageEvent(event, name) &&
          eventIsAfter(event, baselineId, startedAtMs),
      ),
    );
    if (report) {
      return { ok: true, evidence: "hcom agent report", reportId: report.id };
    }
  }

  return {
    ok: false,
    reason:
      `OpenCode resume for "${name}" completed without a post-resume hcom report. ` +
      "The retained session may not support plugin rebind for headless resume; no success was claimed.",
  };
}

function findRetainedRecord(records: RegistryRecord[], target: string): RegistryRecord | undefined {
  const stripped = target.startsWith("@") ? target.slice(1) : target;
  const candidates = records.filter(
    (record) =>
      !record.released &&
      (record.hcomName === stripped || record.sessionId === stripped),
  );
  return candidates.sort((a, b) => {
    const aExact = a.sessionId === stripped ? 1 : 0;
    const bExact = b.sessionId === stripped ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aTime = Date.parse(a.lastSeenAt || a.createdAt);
    const bTime = Date.parse(b.lastSeenAt || b.createdAt);
    if (aTime !== bTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  })[0];
}

async function resolveResumeSource(
  target: string,
  records: RegistryRecord[],
  execHcomFn: typeof execHcom,
): Promise<ResumeSource> {
  const record = findRetainedRecord(records, target);
  const hcomName = record?.hcomName ?? (OPEN_CODE_SESSION_ID.test(target) ? undefined : target.replace(/^@/, ""));

  if (!hcomName) return { record };

  const stopped = await execHcomFn(["list", "--stopped", hcomName]);
  const snapshot = stopped.exitCode === 0 ? parseStoppedAgentSnapshot(stopped.stdout) : {};
  return {
    record,
    hcomName: snapshot.name ?? hcomName,
    sessionId: snapshot.sessionId ?? record?.sessionId,
    tool: snapshot.tool ?? record?.harness,
    directory: snapshot.directory,
  };
}

function activeStateFor(record: RegistryRecord | undefined): "managed_active" | "adopted_active" {
  return record?.state.startsWith("adopted_") || record?.preset === "adopted"
    ? "adopted_active"
    : "managed_active";
}

function stoppedStateFor(record: RegistryRecord): "managed_stopped" | "adopted_stopped" {
  return record.state.startsWith("adopted_") || record.preset === "adopted"
    ? "adopted_stopped"
    : "managed_stopped";
}

export function getOpenCodeResumeCommand(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" ? null : "opencode";
}

async function runHeadlessOpenCodeResume(
  target: string,
  options: {
    workspace?: string;
    tag?: string;
    dir?: string;
    prompt?: string;
  },
  cwd: string,
  source: ResumeSource,
  execCommandFn: typeof execCommand,
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
  if (!source.record || source.record.harness !== "opencode") {
    return toolError(
      E_LAUNCH_FAILED,
      "Headless OpenCode resume requires a retained managed OpenCode record so its hcom identity and hooks can be preserved.",
    );
  }
  if (source.tool && source.tool !== "opencode") {
    return toolError(
      E_LAUNCH_FAILED,
      `Retained agent "${source.hcomName ?? target}" is recorded as ${source.tool}, not OpenCode; refusing an unsafe headless resume.`,
    );
  }
  if (!isRetainedOpenCodeSessionId(source.sessionId)) {
    return toolError(
      E_LAUNCH_FAILED,
      `No retained OpenCode session id is available for "${source.hcomName ?? target}". Resume the stopped hcom agent by name first so its session can be retained.`,
    );
  }

  const hcomName = source.hcomName ?? source.record.hcomName;
  if (!hcomName) {
    return toolError(E_LAUNCH_FAILED, "The retained OpenCode record has no hcom identity; refusing to launch an untracked session.");
  }
  const command = getOpenCodeResumeCommand();
  if (!command) {
    return toolError(
      E_RESUME_UNSUPPORTED,
      "Headless OpenCode resume is unsupported on Windows because the direct executable path cannot be resolved safely without a shell.",
    );
  }
  const directory = options.dir ?? source.directory;
  if (!directory) {
    return toolError(
      E_LAUNCH_FAILED,
      `No retained working directory is available for "${hcomName}". Provide dir explicitly; headless resume will not guess a workspace.`,
    );
  }

  const startedAtMs = Date.now();
  const baselineId = await lastHcomEventId(hcomName, execHcom);
  const prompt = options.prompt?.trim() || DEFAULT_OPEN_CODE_RESUME_PROMPT;
  const processId = `hcom-mcp-resume-${hcomName}-${startedAtMs}`;
  const args = ["run", "--session", source.sessionId, "--format", "json", prompt];
  const result = await execCommandFn(command, args, {
    cwd: directory,
    // Stream the synchronous run and hand it back alive after a generous
    // caller-visible ceiling instead of killing a legitimate long turn.
    handoffTimeoutMs: RESUME_HANDOFF_TIMEOUT_MS,
    env: {
      HCOM_LAUNCHED: "1",
      HCOM_BACKGROUND: "1",
      HCOM_TOOL: "opencode",
      HCOM_INSTANCE_NAME: hcomName,
      HCOM_PROCESS_ID: processId,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { "*": "allow", external_directory: "allow" },
      }),
    },
  });

  const record = upsertResumedRecord(source.record.id, {
    hcomName,
    sessionId: source.sessionId,
    state: stoppedStateFor(source.record),
    launchMode: "headless",
    resumedFrom: target,
    requireReport: source.record.requireReport ?? false,
    dispatchAt: new Date(startedAtMs).toISOString(),
  });
  if (!record) return toolError(E_LAUNCH_FAILED, `Retained ownership record "${source.record.id}" disappeared during resume.`);

  if (result.handedOff) {
    const processDetail = result.pid ? ` Process ${result.pid} was left running.` : " The process was left running.";
    return toolError(
      E_RESUME_INCONCLUSIVE,
      `Headless OpenCode resume exceeded the ${RESUME_HANDOFF_TIMEOUT_MS / 1000}-second handoff wait without completing; no success was claimed.${processDetail} The retained record was settled as ${record.state}.`,
    );
  }

  if (result.exitCode !== 0 || result.timedOut) {
    return toolError(
      E_LAUNCH_FAILED,
      `Headless OpenCode resume failed for "${hcomName}": ${result.stderr || result.stdout || "the opencode process exited without a response"}. The retained record was settled as ${record.state}.`,
    );
  }

  const report = await verifyResumeReport(hcomName, baselineId, startedAtMs, execHcom);
  if (!report.ok) {
    return toolError(
      E_RESUME_UNSUPPORTED,
      `${report.reason} The retained record was settled as ${record.state}.`,
    );
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        kind: "resume",
        target,
        spawnedName: hcomName,
        registryId: record.id,
        resumedFrom: target,
        sessionId: source.sessionId,
        state: record.state,
        evidence: [
          report.evidence,
          ...(hasOpenCodeResponseEvidence(result.stdout, source.sessionId) ? ["opencode response/transcript"] : []),
        ],
        ...(report.reportId ? { reportEventId: report.reportId } : {}),
        command: `opencode ${args.join(" ")}`,
      }, null, 2),
    }],
  };
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
    return toolError(
      E_NO_SENDER,
      "Cannot resolve sender identity. For HTTP or unbound MCP callers, provide the sender_name parameter explicitly. Bound hcom sessions may auto-resolve via 'hcom list self'.",
    );
  }

  const records = getOwnedRecordsByWorkspace(cwd);
  const retained = findRetainedRecord(records, target);
  let source: ResumeSource = {
    record: retained,
    hcomName: retained?.hcomName,
    sessionId: retained?.sessionId,
    tool: retained?.harness,
  };
  const shouldInspectStoppedOpenCode =
    kind === "resume" &&
    options.headless &&
    (retained?.harness === "opencode" || options.harness === "opencode");
  if (shouldInspectStoppedOpenCode) {
    source = await resolveResumeSource(target, records, execHcom);
  }

  // OpenCode's headless resume path cannot use `hcom r`: that command starts a
  // new harness process and does not reliably rebind the retained session.
  if (kind === "resume" && options.headless && (source.record?.harness === "opencode" || source.tool === "opencode")) {
    return runHeadlessOpenCodeResume(target, options, cwd, source, execCommand);
  }

  const args = [kind === "resume" ? "r" : "f", target];
  if (options.tag) args.push("--tag", options.tag);
  if (options.dir) args.push("--dir", options.dir);
  if (options.headless) args.push("--headless");
  if (options.prompt) args.push("--hcom-prompt", options.prompt);
  if (options.go) args.push("--go");

  const startedAtMs = Date.now();
  const baselineId = kind === "resume" && source.hcomName
    ? await lastHcomEventId(source.hcomName, execHcom)
    : 0;
  const result = await execHcom(args);
  if (result.exitCode !== 0) {
    return toolError(
      E_LAUNCH_FAILED,
      `Error ${kind === "resume" ? "resuming" : "forking"} agent: ${result.stderr || result.stdout}`,
    );
  }

  const spawnedName = parseSpawnedName(result.stdout);
  if (!spawnedName) {
    return toolError(
      E_LAUNCH_FAILED,
      `hcom ${kind} succeeded but no agent name could be parsed from its output. No record was registered. Output: ${result.stdout.slice(0, 200)}`,
    );
  }

  let record: RegistryRecord;
  if (kind === "resume" && source.record) {
    const updated = upsertResumedRecord(source.record.id, {
      hcomName: spawnedName,
      sessionId: source.sessionId,
      launchMode: options.headless ? "headless" : "headed",
      state: activeStateFor(source.record),
      resumedFrom: target,
      requireReport: source.record.requireReport ?? false,
      dispatchAt: new Date(startedAtMs).toISOString(),
    });
    if (!updated) {
      return toolError(E_LAUNCH_FAILED, `Retained ownership record "${source.record.id}" disappeared during resume.`);
    }
    record = updated;
  } else {
    // Register ownership. The harness is the caller's best knowledge; the
    // record is still useful for stop/kill/list_managed even if the harness
    // guess is wrong (it only feeds display and adopt-style inference).
    record = addRecord({
      workspace: cwd,
      harness: options.harness ?? source.record?.harness ?? "opencode",
      hcomName: spawnedName,
      preset: kind,
      launchMode: options.headless ? "headless" : "headed",
      state: activeStateFor(source.record),
      released: false,
      launchedBy: caller,
      resumedFrom: target,
      requireReport: source.record?.requireReport ?? false,
      dispatchAt: new Date(startedAtMs).toISOString(),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    });
  }

  if (kind === "resume") {
    const consumption = await verifyResumeConsumption(
      spawnedName,
      baselineId,
      startedAtMs,
      execHcom,
    );
    if (!consumption.ok) return toolError(E_LAUNCH_FAILED, consumption.reason!);
  }

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
    "Resume a stopped agent (hcom r). Registers a new ownership record with a resumedFrom link to the source agent, completing the continue_from handoff story. The source agent's identity is reclaimed when hcom supports it. Returns { kind, target, spawnedName, registryId, resumedFrom, command }. Preconditions: sender identity (see sender_name). Related: continue_from (handoff context), fork (branch instead).",
    {
      name: z.string().describe("Target: hcom name, session UUID, ses_<id>, or thread name."),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
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
        return internalError(err);
      }
    },
  );

  server.tool(
    "fork",
    "Fork an agent session (hcom f): creates a new agent that continues from the forked session. Registers a new ownership record with a resumedFrom link to the source agent. Returns { kind, target, spawnedName, registryId, resumedFrom, command }. Preconditions: sender identity (see sender_name). Related: continue_from (handoff context), resume (continue the same session).",
    {
      name: z.string().describe("Target: hcom name, session UUID, ses_<id>, or thread name."),
      workspace: z.string().optional().describe("Workspace path for ownership tracking. Defaults to the server's working directory. Pass explicitly when the server runs under a service manager (its cwd is the service home, not your workspace) so records are scoped to the workspace you query with list_managed."),
      sender_name: z.string().optional().describe("Sender identity recorded as the launcher. REQUIRED for HTTP or unbound MCP callers: auto-resolution via 'hcom list self' never succeeds there, and the call fails with E_NO_SENDER. Bound hcom sessions may omit it."),
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
        return internalError(err);
      }
    },
  );
}
