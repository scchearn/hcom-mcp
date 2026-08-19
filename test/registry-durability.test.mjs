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

test('addRecord writes atomically: no tmp file left, valid JSON on disk', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-reg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });

  const reg = await loadRegistryModule();
  const record = reg.addRecord(makeRecord());

  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  assert.equal(existsSync(registryPath), true);
  assert.equal(existsSync(`${registryPath}.tmp`), false);

  const parsed = JSON.parse(readFileSync(registryPath, 'utf-8'));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].id, record.id);
  assert.equal(parsed.records[0].hcomName, 'waka');
});

test('addRecord survives a failed rename without touching the live file', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-reg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });
  t.mock.module('node:fs', {
    namedExports: {
      readFileSync: (p, o) => realFs.readFileSync(p, o),
      writeFileSync: (p, d, o) => realFs.writeFileSync(p, d, o),
      existsSync: (p) => realFs.existsSync(p),
      mkdirSync: (p, o) => realFs.mkdirSync(p, o),
      renameSync: () => {
        throw new Error('rename failed');
      },
    },
  });

  const reg = await loadRegistryModule();
  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  realFs.mkdirSync(join(home, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ records: [makeRecord({ id: 'old-1' })] }), 'utf-8');

  assert.throws(() => reg.addRecord(makeRecord({ id: 'new-1' })), /rename failed/);

  // The live file must still hold the original content — a direct write would
  // have overwritten it before the (failed) rename.
  const parsed = JSON.parse(readFileSync(registryPath, 'utf-8'));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].id, 'old-1');
});

test('corrupt JSON is quarantined and surfaced, never overwritten with empty state', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-reg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });

  const reg = await loadRegistryModule();
  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  realFs.mkdirSync(join(home, '.hcom', 'mcp'), { recursive: true });
  writeFileSync(registryPath, 'not json {{{', 'utf-8');

  assert.throws(
    () => reg.addRecord(makeRecord()),
    (err) => {
      assert.equal(err.name, 'RegistryError');
      assert.match(err.message, /not valid JSON/);
      assert.match(err.message, /quarantined/);
      assert.ok(err.quarantinePath);
      return true;
    },
  );

  // The corrupt original is preserved for inspection.
  const quarantined = readFileSync(errQuarantinePath(), 'utf-8');
  assert.equal(quarantined, 'not json {{{');
  // The live file is untouched — the empty-state overwrite is gone.
  assert.equal(readFileSync(registryPath, 'utf-8'), 'not json {{{');

  function errQuarantinePath() {
    const files = readdirSync(join(home, '.hcom', 'mcp')).filter((f) => f.startsWith('registry.corrupt-'));
    assert.equal(files.length, 1);
    return join(home, '.hcom', 'mcp', files[0]);
  }
});

test('one bad record is quarantined while good records are kept and the file heals', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-reg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });

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
      assert.match(err.message, /1 invalid record/);
      assert.match(err.message, /quarantined/);
      return true;
    },
  );

  // The bad record is preserved in quarantine.
  const files = readdirSync(join(home, '.hcom', 'mcp')).filter((f) => f.startsWith('registry.corrupt-'));
  assert.equal(files.length, 1);
  const quarantined = JSON.parse(readFileSync(join(home, '.hcom', 'mcp', files[0]), 'utf-8'));
  assert.equal(quarantined[0].id, 'bad-1');

  // The live file healed: only the good record remains.
  const healed = JSON.parse(readFileSync(registryPath, 'utf-8'));
  assert.equal(healed.records.length, 1);
  assert.equal(healed.records[0].id, 'good-1');

  // Subsequent writes work on the healed file.
  const record = reg.addRecord(makeRecord({ hcomName: 'new-1' }));
  const after = JSON.parse(readFileSync(registryPath, 'utf-8'));
  assert.deepEqual(after.records.map((r) => r.hcomName).sort(), ['new-1', 'waka']);
  assert.equal(record.hcomName, 'new-1');
});

test('missing registry file loads as empty and addRecord creates it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hcom-reg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.module('node:os', { namedExports: { homedir: () => home } });

  const reg = await loadRegistryModule();
  const record = reg.addRecord(makeRecord());

  const registryPath = join(home, '.hcom', 'mcp', 'registry.json');
  assert.equal(existsSync(registryPath), true);
  const parsed = JSON.parse(readFileSync(registryPath, 'utf-8'));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].id, record.id);
});
