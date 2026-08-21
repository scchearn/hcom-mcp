// Loaded via `node --import` before every test worker's module graph (the
// node:test runner propagates --import to each spawned test-file process).
//
// Redirects HOME to a per-process temp dir BEFORE any test module loads, so
// os.homedir() — and therefore REGISTRY_DIR/REGISTRY_PATH in dist/registry.js,
// which are resolved at import time — land under a throwaway root. No test
// can reach the real ~/.hcom/mcp state through homedir(); if the redirect
// ever fails to take effect, the worker dies loudly instead of leaking.
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const realHome = process.env.HOME || homedir();
const tempHome = mkdtempSync(join(tmpdir(), "hcom-mcp-test-home-"));

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

if (homedir() !== tempHome) {
  throw new Error(
    `[E_TEST_ISOLATION] HOME redirect failed: homedir() resolved to ${homedir()}, expected ${tempHome}`,
  );
}

globalThis.__HCOM_TEST_ISOLATION__ = {
  realHome,
  tempHome,
  realRegistryPath: join(realHome, ".hcom", "mcp", "registry.json"),
};
