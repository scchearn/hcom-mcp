// Systemic guard for issue #36 Bug 1: fails the suite if any test worker can
// reach the real ~/.hcom/mcp registry. Depends on test/helpers/isolate-home.mjs
// being loaded via --import before this worker's module graph.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isolation = globalThis.__HCOM_TEST_ISOLATION__;

test("isolation preload ran in this worker", () => {
  assert.ok(
    isolation,
    "[E_TEST_ISOLATION] preload missing — npm test must load test/helpers/isolate-home.mjs via --import",
  );
});

test("homedir() in this worker resolves under the temp root, never the real home", () => {
  assert.ok(
    homedir().startsWith(isolation.tempHome),
    `homedir() escaped the temp root: ${homedir()}`,
  );
  assert.notEqual(homedir(), isolation.realHome);
});

test("REGISTRY_PATH resolves under the per-worker temp home, never the real home", async () => {
  const { REGISTRY_DIR, REGISTRY_PATH } = await import(
    `../dist/registry.js?guard-${Date.now()}`
  );
  assert.ok(
    REGISTRY_PATH.startsWith(isolation.tempHome),
    `REGISTRY_PATH escaped the temp root: ${REGISTRY_PATH}`,
  );
  assert.notEqual(REGISTRY_PATH, isolation.realRegistryPath);
  assert.equal(REGISTRY_DIR, join(isolation.tempHome, ".hcom", "mcp"));
});

test("a full addRecord cycle writes only inside the temp root", async (t) => {
  const registryModule = await import(`../dist/registry.js?guard-write-${Date.now()}`);
  const record = registryModule.addRecord({
    workspace: join(isolation.tempHome, "ws"),
    harness: "opencode",
    state: "managed_active",
    createdAt: "2026-08-21T00:00:00.000Z",
    lastSeenAt: "2026-08-21T00:00:00.000Z",
    released: false,
  });
  t.after(() =>
    rmSync(join(isolation.tempHome, ".hcom"), { recursive: true, force: true }),
  );

  const parsed = JSON.parse(
    readFileSync(join(isolation.tempHome, ".hcom", "mcp", "registry.json"), "utf-8"),
  );
  assert.ok(parsed.records.some((r) => r.id === record.id));
});
