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
export type ExecHcomFn = typeof execHcom;

/**
 * Install ONE hcom event subscription on behalf of a hub. Single shared
 * implementation for both consumers (watch_agents subscribe mode and the
 * launch-time supervision lane) — the arg vectors and the stdout sub-id
 * parse exist exactly once.
 *
 * ponytail: `sub-[a-f0-9]+` matches hcom's CLI stdout, the most drift-prone
 * input in this codebase. When hcom's output format changes, fix the regex
 * HERE only; both lanes follow.
 */
export async function installSubscription(
  hub: string,
  name: string,
  kind: "life" | "blocked",
  execHcomFn: ExecHcomFn = execHcom,
): Promise<SupervisionSubscription> {
  const args =
    kind === "life"
      ? ["events", "sub", "--for", hub, "--agent", name, "--type", "life"]
      : ["events", "sub", "--for", hub, "--status", "blocked", "--agent", name];
  const result = await execHcomFn(args);
  const subId = result.stdout.match(/sub-[a-f0-9]+/)?.[0];
  if (result.exitCode !== 0 || !subId) {
    throw new Error(result.stderr || result.stdout || "no subscription id in hcom output");
  }
  return { kind, subId };
}

export interface SubscriptionInstall {
  name: string;
  subscriptions: SupervisionSubscription[];
  // Non-fatal install failures. A launch stays successful when a
  // subscription could not be created: the push lane degrades but the
  // record still carries policy + baseline, so the M2 watchdog sweep still
  // covers silence detection. Errors are persisted onto the record's
  // installErrors so the sweep can see the degraded push lane.
  errors?: string[];
}

/**
 * Ids of all hcom event subscriptions currently installed, from
 * `hcom events sub list`. Returns null when the CLI fails so callers can
 * skip verification rather than misread "no subs" — one call covers every
 * record in a sweep.
 */
export async function listSubscriptionIds(
  execHcomFn: ExecHcomFn = execHcom,
): Promise<Set<string> | null> {
  const result = await execHcomFn(["events", "sub", "list"]);
  if (result.exitCode !== 0) return null;
  return new Set([...result.stdout.matchAll(/^(sub-[a-f0-9]+)/gm)].map((m) => m[1]));
}

/**
 * Install the #33 push-lane subscriptions for one worker on behalf of its
 * launching hub: lifecycle milestones (`life`: ready/stopped/lost/launch
 * failure) and `blocked` approval-required state.
 *
 * Idempotent per kind WITHIN A SESSION: a kind already carrying an id is
 * skipped. Stored ids are NOT revalidated unless the caller passes
 * `verify` — M4 rehydration passes a checker built from
 * listSubscriptionIds so subscriptions hcom dropped are reinstalled
 * exactly once, without duplicating the ones that survived.
 */
export async function ensureSupervisionSubscriptions(
  hub: string,
  name: string,
  existing: SupervisionSubscription[] = [],
  execHcomFn: ExecHcomFn = execHcom,
  verify?: (subId: string) => Promise<boolean>,
): Promise<{ subscriptions: SupervisionSubscription[]; errors: string[] }> {
  let subscriptions = [...existing];
  const errors: string[] = [];

  for (const kind of ["life", "blocked"] as const) {
    const stored = subscriptions.find((sub) => sub.kind === kind);
    if (stored) {
      if (!verify) continue;
      let alive = false;
      try {
        alive = await verify(stored.subId);
      } catch {
        alive = true; // verification failure must not cause reinstalls
      }
      if (alive) continue;
      subscriptions = subscriptions.filter((sub) => sub !== stored);
    }
    try {
      subscriptions.push(await installSubscription(hub, name, kind, execHcomFn));
    } catch (err: any) {
      errors.push(`${kind}: ${err?.message ?? err}`);
    }
  }

  return { subscriptions, errors };
}
