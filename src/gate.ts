// Pure parsing helpers for launch gating and PTY rescue. Deliberately free of
// hcom.js imports so partial mocks of hcom.js in tests cannot break linking.

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface LifeEvent {
  action?: string;
  status?: string;
  reason?: string;
  detail?: string;
  instance?: string;
}

/**
 * Extract life events from a JSON blob that may be a bare array, a
 * { data: [...] } wrapper, or a LaunchResult payload with a nested events
 * array. Used to disambiguate exit-2 launch gates and to re-check a rescued
 * agent's state.
 */
export function parseLifeEvents(raw: string): LifeEvent[] {
  const parsed = parseJson(raw);
  if (!parsed) return [];

  const candidates: unknown[] = [];
  if (Array.isArray(parsed)) {
    candidates.push(...parsed);
  } else if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      candidates.push(...(obj.data as unknown[]));
    }
    if (Array.isArray(obj.events)) {
      candidates.push(...(obj.events as unknown[]));
    }
  }

  return candidates
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => {
      const data = (c.data ?? c) as Record<string, unknown>;
      return {
        action: typeof data.action === "string" ? data.action : undefined,
        status: typeof data.status === "string" ? data.status : undefined,
        reason: typeof data.reason === "string" ? data.reason : undefined,
        detail: typeof data.detail === "string" ? data.detail : undefined,
        instance: typeof data.instance === "string" ? data.instance : undefined,
      };
    })
    .filter((e) => e.action !== undefined || e.status !== undefined);
}

export interface TermScreen {
  lines?: string[];
  ready?: boolean;
  prompt_empty?: boolean;
  input_text?: string;
}

/**
 * Parse `hcom term <name> --json` output. Falls back to a single-line
 * placeholder when the CLI returns non-JSON (older hcom versions).
 */
export function parseTermJson(stdout: string): TermScreen {
  const parsed = parseJson(stdout);
  if (parsed && typeof parsed === "object") {
    return parsed as TermScreen;
  }
  return { lines: [stdout] };
}

export interface LaunchGateResult {
  outcome: "ready" | "failed" | "timeout" | "blocked";
  reason?: string;
  detail?: string;
}

/**
 * Parse the JSON emitted by `hcom events launch <batchId> --timeout <sec>`.
 * Exit codes: 0 ready, 1 error/no_launches, 2 timeout/blocked. The payload
 * shape is not contractual, so every field is read defensively.
 */
export function parseLaunchGateResult(
  stdout: string,
  exitCode: number,
): LaunchGateResult {
  const parsed = parseJson(stdout);
  const data = (parsed && typeof parsed === "object"
    ? ((parsed as Record<string, unknown>).data ?? parsed)
    : null) as Record<string, unknown> | null;

  if (exitCode === 0) {
    return { outcome: "ready" };
  }

  if (exitCode === 1) {
    return {
      outcome: "failed",
      reason: typeof data?.reason === "string" ? data.reason : undefined,
      detail: typeof data?.detail === "string" ? data.detail : undefined,
    };
  }

  // Exit 2 is "timeout OR blocked" — disambiguate by reading the last life event.
  const lastLife = parseLifeEvents(stdout)[0];
  if (lastLife?.action === "launch_blocked") {
    return {
      outcome: "blocked",
      reason: lastLife.reason,
      detail: lastLife.detail,
    };
  }

  return {
    outcome: "timeout",
    reason: typeof data?.reason === "string" ? data.reason : undefined,
    detail: typeof data?.detail === "string" ? data.detail : undefined,
  };
}
