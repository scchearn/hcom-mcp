import { execHcom } from "./hcom.js";
import type { ExecResult } from "./hcom.js";
import {
  SupervisionPolicySchema,
  type SupervisionPolicy,
  type SupervisionPolicyInput,
  type SupervisionSubscription,
} from "./types.js";

/**
 * Built-in supervision policy (#33): first alert after three minutes of
 * silence, escalation at six minutes total, measured from the dispatch
 * baseline. Single source of truth — the zod defaults in types.ts feed this,
 * and every resolution layer merges over it.
 */
export function defaultSupervisionPolicy(): SupervisionPolicy {
  return SupervisionPolicySchema.parse({});
}

/**
 * Resolve the effective supervision policy for one launch. Layers merge in
 * order (earliest first, later layers win per-field):
 * global config -> preset -> per-launch parameters. Unset fields fall
 * through to the previous layer, ultimately to the built-in defaults.
 */
export function resolveSupervisionPolicy(
  ...layers: (SupervisionPolicyInput | undefined)[]
): SupervisionPolicy {
  const merged: SupervisionPolicyInput = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.enabled !== undefined) merged.enabled = layer.enabled;
    if (layer.attentionAfterSec !== undefined) merged.attentionAfterSec = layer.attentionAfterSec;
    if (layer.escalateAfterSec !== undefined) merged.escalateAfterSec = layer.escalateAfterSec;
  }
  return SupervisionPolicySchema.parse(merged);
}

export interface SubscriptionInstall {
  name: string;
  subscriptions: SupervisionSubscription[];
  // Non-fatal install failures. A launch stays successful when a
  // subscription could not be created: the push lane degrades but the
  // record still carries policy + baseline, so the M2 watchdog sweep still
  // covers silence detection.
  errors?: string[];
}

/**
 * Install the #33 push-lane subscriptions for one worker on behalf of its
 * launching hub: lifecycle milestones (`life`: ready/stopped/lost/launch
 * failure) and `blocked` approval-required state. Idempotent per kind — a
 * kind already carrying a subscription id is never installed twice, so
 * rehydration (M4) can call this again without duplicating.
 *
 * Reuses the same `hcom events sub --for <hub>` mechanism as
 * watch_agents subscribe mode.
 */
export async function ensureSupervisionSubscriptions(
  hub: string,
  name: string,
  existing: SupervisionSubscription[] = [],
  // Dependency injection: callers pass their own execHcom binding so tests
  // (and future sweep contexts) never depend on this module's load-time
  // binding — the same pattern as gateLaunch's execHcomFn.
  execHcomFn: typeof execHcom = execHcom,
): Promise<{ subscriptions: SupervisionSubscription[]; errors: string[] }> {
  const subscriptions = [...existing];
  const errors: string[] = [];

  for (const kind of ["life", "blocked"] as const) {
    if (subscriptions.some((sub) => sub.kind === kind)) continue;
    const args =
      kind === "life"
        ? ["events", "sub", "--for", hub, "--agent", name, "--type", "life"]
        : ["events", "sub", "--for", hub, "--status", "blocked", "--agent", name];
    const result = await execHcomFn(args);
    const subId = result.stdout.match(/sub-[a-f0-9]+/)?.[0];
    if (result.exitCode === 0 && subId) {
      subscriptions.push({ kind, subId });
    } else {
      errors.push(
        `${kind}: ${result.stderr || result.stdout || "no subscription id in hcom output"}`,
      );
    }
  }

  return { subscriptions, errors };
}
