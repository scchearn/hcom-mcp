import { execHcom, inferHarnessFromTool } from "./hcom.js";
import type { ExecHcomFn } from "./supervision.js";
import { SUPERVISOR_IDENTITY } from "./supervision.js";
import { eventData, eventTimeMs, parseHcomEvents, type HcomEvent } from "./events.js";
import { adoptRecord, resolveRootLauncher } from "./registry.js";
import type { HcomAgent, RegistryRecord } from "./types.js";

/**
 * #37 auto-adopt: descendants of managed workers.
 *
 * Parentage mechanism (investigated 2026-08-21 against live hcom output):
 * `life` events of action `batch_launched` carry `by` (the spawner's
 * identity — "user" for hub/human launches) and `instances[]` (the spawned
 * base names). A batch_launched whose `by` matches a managed record's
 * hcomName is therefore a spawn by that managed worker. `parent_name` on
 * HcomAgent is null for every agent observed so far and is NOT relied on;
 * session linkage cannot cross processes. If hcom later populates
 * parent_name reliably, it can be added as a second signal — this module
 * deliberately acts only on unambiguous evidence and leaves everything
 * else untracked (visible as "unmanaged" via list_all), never guessing.
 *
 * Whole-tree coverage comes from repetition: each adopted generation
 * becomes a managed record, so its own spawns match the same rule on a
 * later sweep. No new ownership semantics — adoptRecord + the existing
 * adopted_* reconcile/terminal paths do the rest.
 */

export interface DescendantAdoption {
  name: string;
  ancestor: string;
  hub: string | null;
}

function extractBatchLaunches(events: HcomEvent[]): { by: string; instances: string[]; atMs: number | null }[] {
  const launches: { by: string; instances: string[]; atMs: number | null }[] = [];
  for (const event of events) {
    const data = eventData(event);
    if (data.action !== "batch_launched") continue;
    const by = typeof data.by === "string" ? data.by : null;
    const instances = Array.isArray(data.instances)
      ? data.instances.filter((i): i is string => typeof i === "string")
      : [];
    if (!by || instances.length === 0 || by === "user") continue;
    launches.push({ by, instances, atMs: eventTimeMs(event) });
  }
  return launches;
}

export async function detectAndAdoptDescendants(deps: {
  records: RegistryRecord[];
  liveAgents: HcomAgent[];
  execHcomFn?: ExecHcomFn;
}): Promise<{ adopted: DescendantAdoption[]; skipped: string[] }> {
  const execHcomFn = deps.execHcomFn ?? execHcom;
  const adopted: DescendantAdoption[] = [];
  const skipped: string[] = [];

  // Managed ancestors: any non-released owned record with an hcom name —
  // launched AND adopted generations both trigger the rule (whole tree).
  // M7a: the ancestor must be LIVE right now and the spawn must postdate
  // its creation — CVCV names get reused, and a batch_launched by a name
  // that only matches a long-dead record says nothing about lineage.
  const liveBaseNames = new Set(deps.liveAgents.map((a) => a.base_name));
  const managedByName = new Map<string, RegistryRecord>();
  for (const record of deps.records) {
    if (record.released || !record.hcomName) continue;
    if (!liveBaseNames.has(record.hcomName)) continue;
    // m22: duplicate live names resolve to the NEWEST record — its
    // createdAt is what gates the recency check.
    const incumbent = managedByName.get(record.hcomName);
    if (!incumbent || record.createdAt > incumbent.createdAt) {
      managedByName.set(record.hcomName, record);
    }
  }
  if (managedByName.size === 0) return { adopted, skipped };

  // M7b: dedup against EVERY record ever carrying the name, released
  // included — a deliberately released agent must not be re-adopted every
  // sweep while its batch_launched event is still in the window.
  const knownNames = new Set(
    deps.records.filter((r) => r.hcomName).map((r) => r.hcomName as string),
  );

  let events: HcomEvent[] = [];
  try {
    const result = await execHcomFn(["events", "--last", "100", "--type", "life"]);
    if (result.exitCode === 0) events = parseHcomEvents(result.stdout);
  } catch {
    return { adopted, skipped: ["descendant detection: hcom events query failed"] };
  }

  for (const launch of extractBatchLaunches(events)) {
    const launchMs = launch.atMs;
    const ancestor = managedByName.get(launch.by);
    if (!ancestor) continue; // spawner is not ours (or not live): leave untracked
    // M7a recency: a spawn predating the ancestor record's creation is a
    // name-reuse coincidence, not lineage.
    if (launchMs !== null && launchMs < (eventTimeMs(ancestor.createdAt) ?? 0)) continue;

    const hub = resolveRootLauncher(ancestor, deps.records) ?? ancestor.launchedBy ?? null;

    for (const instance of launch.instances) {
      if (instance === launch.by) continue; // never self-adopt
      const live = deps.liveAgents.find(
        (a) => a.name === instance || a.base_name === instance,
      );
      if (!live) {
        skipped.push(`${instance}: not live in hcom`);
        continue;
      }
      if (knownNames.has(live.base_name)) continue; // already managed or previously released

      const harness = inferHarnessFromTool(live.tool);
      if (!harness) {
        skipped.push(`${instance}: unknown harness "${live.tool ?? "undefined"}"`);
        continue;
      }

      const record = adoptRecord({
        workspace: ancestor.workspace,
        harness,
        hcomName: live.base_name,
        sessionId: live.session_id,
        launchedBy: hub ?? undefined,
        launchMode: live.headless === false ? "headed" : "headless",
      });
      knownNames.add(live.base_name);
      adopted.push({ name: live.base_name, ancestor: launch.by, hub });

      // Adoption notice without a caller identity: sent externally, best-
      // effort — ownership does not depend on delivery.
      const text = [
        "You have been adopted into hcom-mcp managed lifecycle.",
        `hub: ${hub ?? "(unattributed)"}  your name: ${live.base_name}  harness: ${harness}  workspace: ${ancestor.workspace}`,
        `Stop/kill commands from ${hub ?? "the hub"} are now authoritative for your session.`,
      ].join("\n");
      await execHcomFn(["send", `@${live.base_name}`, "--from", SUPERVISOR_IDENTITY, "--intent", "inform", "--", text]);
    }
  }

  return { adopted, skipped };
}
