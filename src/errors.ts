// Stable error-code contract for tool responses.
//
// Every tool error response carries a prefixed token alongside prose:
//   [E_NO_SENDER] Cannot resolve sender identity. ...
// Clients can match on the token; the prose stays human-readable. Codes are
// stable across releases — never rename or repurpose an existing token.

export const E_NO_SENDER = "E_NO_SENDER";
export const E_NOT_MANAGED = "E_NOT_MANAGED";
export const E_AGENT_NOT_FOUND = "E_AGENT_NOT_FOUND";
export const E_AGENT_NOT_LIVE = "E_AGENT_NOT_LIVE";
export const E_AGENT_NOT_BLOCKED = "E_AGENT_NOT_BLOCKED";
export const E_SELF_PROTECTION = "E_SELF_PROTECTION";
export const E_PRESET_NOT_FOUND = "E_PRESET_NOT_FOUND";
export const E_TOPOLOGY_NOT_FOUND = "E_TOPOLOGY_NOT_FOUND";
export const E_HARNESS_REQUIRED = "E_HARNESS_REQUIRED";
export const E_INVALID_TOPOLOGY_REF = "E_INVALID_TOPOLOGY_REF";
export const E_TARGET_REQUIRED = "E_TARGET_REQUIRED";
export const E_NAME_REQUIRED = "E_NAME_REQUIRED";
export const E_PATTERN_REQUIRED = "E_PATTERN_REQUIRED";
export const E_ACK_REQUIRES_REPLY_TO = "E_ACK_REQUIRES_REPLY_TO";
export const E_UNKNOWN_HARNESS = "E_UNKNOWN_HARNESS";
export const E_LAUNCH_FAILED = "E_LAUNCH_FAILED";
export const E_BUNDLE_FAILED = "E_BUNDLE_FAILED";
export const E_TRANSCRIPT_FAILED = "E_TRANSCRIPT_FAILED";
export const E_THREAD_FAILED = "E_THREAD_FAILED";
export const E_SEND_FAILED = "E_SEND_FAILED";
export const E_STOP_FAILED = "E_STOP_FAILED";
export const E_KILL_FAILED = "E_KILL_FAILED";
export const E_REPORT_REQUIRED = "E_REPORT_REQUIRED";
export const E_INJECTION_REFUSED = "E_INJECTION_REFUSED";
export const E_INJECTION_FAILED = "E_INJECTION_FAILED";
export const E_PRUNE_KILL_FAILED = "E_PRUNE_KILL_FAILED";
export const E_INTERNAL = "E_INTERNAL";

export interface ToolErrorResponse {
  content: { type: "text"; text: string }[];
  isError: true;
}

/**
 * Build a tool error response with the stable [E_*] token prefix.
 */
export function toolError(code: string, message: string): ToolErrorResponse {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

/**
 * Wrap an unexpected exception into an E_INTERNAL tool error.
 */
export function internalError(err: unknown): ToolErrorResponse {
  return toolError(E_INTERNAL, err instanceof Error ? err.message : String(err));
}
