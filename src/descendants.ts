import { execHcom, inferHarnessFromTool } from "./hcom.js";
import type { ExecHcomFn } from "./supervision.js";
import { eventData, parseHcomEvents, type HcomEvent } from "./events.js";
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

function extractBatchLaunches(events: HcomEvent[]): { by: string; instances: string[] }[] {
  const launches: { by: string; instances: string[] }[] = [];
  for (const event of events) {
    const data = eventData(event);
    if (data.action !== "batch_launched") continue;
    const by = typeof data.by === "string" ? data.by : null;
    const instances = Array.isArray(data.instances)
      ? data.instances.filter((i): i is string => typeof i === "string")
      : [];
    if (!by || instances.length === 0 || by === "user") continue;
    launches.push({ by, instances });
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
  const managedByName = new Map<string, RegistryRecord>();
  for (const record of deps.records) {
    if (record.released || !record.hcomName) continue;
    managedByName.set(record.hcomName, record);
  }
  if (managedByName.size === 0) return { adopted, skipped };

  // Owned names, for dedup regardless of which workspace holds the record.
  const ownedNames = new Set(
    deps.records.filter((r) => !r.released && r.hcomName).map((r) => r.hcomName as string),
  );

  let events: HcomEvent[] = [];
  try {
    const result = await execHcomFn(["events", "--last", "100", "--type", "life"]);
    if (result.exitCode === 0) events = parseHcomEvents(result.stdout);
  } catch {
    return { adopted, skipped: ["descendant detection: hcom events query failed"] };
  }

  for (const launch of extractBatchLaunches(events)) {
    const ancestor = managedByName.get(launch.by);
    if (!ancestor) continue; // spawner is not ours: leave untracked

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
      if (ownedNames.has(live.base_name)) continue; // already managed

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
      });
      ownedNames.add(live.base_name);
      adopted.push({ name: live.base_name, ancestor: launch.by, hub });

      // Adoption notice without a caller identity: sent externally, best-
      // effort — ownership does not depend on delivery.
      const text = [
        "You have been adopted into hcom-mcp managed lifecycle.",
        `hub: ${hub ?? "(unattributed)"}  your name: ${live.base_name}  harness: ${harness}  workspace: ${ancestor.workspace}`,
        `Stop/kill commands from ${hub ?? "the hub"} are now authoritative for your session.`,
      ].join("\n");
      await execHcomFn(["send", `@${live.base_name}`, "--intent", "inform", "--", text]);
    }
  }

  return { adopted, skipped };
}
