import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realFs from 'node:fs';

let importCounter = 0;

async function loadRegistryModule() {
  importCounter += 1;
  return import(`../dist/registry.js?${importCounter}`);
}

function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    preset: 'adhoc',
    launchMode: 'headless',
    state: 'managed_active',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    released: false,
    ...overrides,
  };
}

function mockHcom(t, { liveAgents = [], stoppedNames = [] } = {}) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => liveAgents,
      listStoppedAgentNames: async () => stoppedNames,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
    },
  });
}

function seedRegistry(home, records) {
  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  realFs.mkdirSync(join(home, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ records }), 'utf-8');
  return registryPath;
}

function readRegistry(home) {
  return JSON.parse(readFileSync(join(home, '.hcom', 'mcp', 'registry.json'), 'utf-8'));
}

// --- #13: reconcile-first prune ---

test('a failing heal-write surfaces the RegistryError with the quarantine path', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-heal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  // Break the heal-write: the tmp write fails (e.g. disk full / permissions).
  // The quarantine write (registry.corrupt-*.json) still succeeds.
  t.mock.module('node:fs', {
    namedExports: {
      readFileSync: (p, o) => realFs.readFileSync(p, o),
      writeFileSync: (p, d, o) => {
        if (String(p).endsWith('.tmp')) throw new Error('ENOSPC: no space left on device');
        return realFs.writeFileSync(p, d, o);
      },
      existsSync: (p) => realFs.existsSync(p),
      mkdirSync: (p, o) => realFs.mkdirSync(p, o),
      renameSync: (p, o) => realFs.renameSync(p, o),
    },
  });

  const reg = await loadRegistryModule();
  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  realFs.mkdirSync(join(home, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({
      records: [
        makeRecord({ id: 'good-1' }),
        { id: 'bad-1', workspace: '/repo', harness: 'not-a-harness', state: 'bogus' },
      ],
    }),
    'utf-8',
  );

  assert.throws(
    () => reg.addRecord(makeRecord({ id: 'new-1' })),
    (err) => {
      assert.equal(err.name, 'RegistryError');
      assert.match(err.message, /heal-write failed/);
      assert.match(err.message, /quarantined/);
      assert.ok(err.quarantinePath);
      return true;
    },
  );

  // The bad record is still preserved in quarantine.
  const files = readdirSync(join(home, '.hcom', 'mcp')).filter((f) => f.startsWith('registry.corrupt-'));
  assert.equal(files.length, 1);
});

// --- prune tool: expired mode kills agents before clearing records ---

