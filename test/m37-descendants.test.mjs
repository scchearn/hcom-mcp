import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Same registry file the cached dist/registry.js module uses (isolate-home
// preload temp root).
const { REGISTRY_PATH } = await import('../dist/registry.js?m37-base');
after(() => rmSync(join(REGISTRY_PATH, '..', '..'), { recursive: true, force: true }));

let importCounter = 0;
const BASE = 1755700000000;
const iso = (ms) => new Date(ms).toISOString();

function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    preset: 'adhoc',
    launchMode: 'headless',
    state: 'managed_active',
    createdAt: iso(BASE),
    lastSeenAt: iso(BASE),
    released: false,
    launchedBy: 'nora',
    requireReport: false,
    ...overrides,
  };
}

function batchLaunched(by, instances) {
  return JSON.stringify({
    id: 900, ts: iso(BASE), type: 'life', instance: by,
    data: { action: 'batch_launched', by, instances, count_requested: instances.length, launched: instances.length },
  });
}

function seedRegistry(records) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ records }), 'utf-8');
}

function readRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
}

function mockHcom(t, { liveAgents, sends }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (o) => o,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ?? id,
      inferHarnessFromTool: (tool) =>
        tool === 'opencode' ? 'opencode' : tool === 'claude' ? 'claude' : null,
      parseHcomJson: JSON.parse,
      listHcomAgents: async () => liveAgents,
      listStoppedAgentNames: async () => [],
      execHcom: async (args) => {
        if (args[0] === 'events') return { exitCode: 0, stdout: args.includes('batch_launched-events') ? '' : eventsFixture, stderr: '' };
        if (args[0] === 'send') { sends.push(args); return { exitCode: 0, stdout: 'Sent', stderr: '' }; }
        if (args[0] === 'list') return { exitCode: 0, stdout: JSON.stringify(liveAgents), stderr: '' };
        throw new Error(`unexpected hcom args: ${args.join(' ')}`);
      },
    },
  });
}

let eventsFixture = '';

test('a managed worker spawn is auto-adopted with root-launcher ownership routing', async (t) => {
  seedRegistry([
    // Resume chain rooted at nora: waka2 -> waka(launchedBy nora).
    makeRecord({ id: 'root', hcomName: 'waka', launchedBy: 'nora' }),
    makeRecord({ id: 'mid', hcomName: 'waka2', launchedBy: 'mid', resumedFrom: 'root' }),
  ]);
  const liveAgents = [
    { name: 'waka', base_name: 'waka', status: 'listening', tool: 'opencode', session_id: 'ses_parent' },
    { name: 'child1', base_name: 'child1', status: 'listening', tool: 'claude', session_id: 'ses_child1' },
  ];
  const sends = [];
  mockHcom(t, { liveAgents, sends });
  eventsFixture = [batchLaunched('waka', ['child1'])].join('\n');

  const { detectAndAdoptDescendants } = await import(`../dist/descendants.js?m37-${++importCounter}`);
  const records = readRegistry().records;
  const { adopted, skipped } = await detectAndAdoptDescendants({
    records, liveAgents, execHcomFn: undefined,
  });

  assert.equal(skipped.length, 0);
  assert.deepEqual(adopted.map((a) => ({ name: a.name, ancestor: a.ancestor, hub: a.hub })), [
    { name: 'child1', ancestor: 'waka', hub: 'nora' },
  ]);

  // Record written with adopt semantics + owner-of-record routing.
  const adoptedRecord = readRegistry().records.find((r) => r.hcomName === 'child1');
  assert.equal(adoptedRecord.preset, 'adopted');
  assert.equal(adoptedRecord.state, 'adopted_active');
  assert.equal(adoptedRecord.launchedBy, 'nora');
  assert.equal(adoptedRecord.workspace, '/repo');
  assert.equal(adoptedRecord.sessionId, 'ses_child1');

  // Adoption notice delivered to the adoptee.
  assert.ok(sends.some((a) => a[1] === '@child1'));
});

test('user-launched batches and unknown spawners are left untracked', async (t) => {
  seedRegistry([makeRecord({ id: 'r1', hcomName: 'waka' })]);
  const liveAgents = [
    { name: 'waka', base_name: 'waka', status: 'listening', tool: 'opencode' },
    { name: 'stranger', base_name: 'stranger', status: 'listening', tool: 'claude' },
  ];
  const sends = [];
  mockHcom(t, { liveAgents, sends });
  eventsFixture = [
    batchLaunched('user', ['stranger']),
    batchLaunched('nobody-i-know', ['stranger']),
  ].join('\n');

  const { detectAndAdoptDescendants } = await import(`../dist/descendants.js?m37-${++importCounter}`);
  const { adopted, skipped } = await detectAndAdoptDescendants({
    records: readRegistry().records, liveAgents,
  });
  assert.deepEqual(adopted, []);
});

test('already-managed names are never re-adopted', async (t) => {
  seedRegistry([
    makeRecord({ id: 'r1', hcomName: 'waka' }),
    makeRecord({ id: 'r2', hcomName: 'child1', preset: 'adopted', state: 'adopted_active' }),
  ]);
  const liveAgents = [
    { name: 'waka', base_name: 'waka', status: 'listening', tool: 'opencode' },
    { name: 'child1', base_name: 'child1', status: 'listening', tool: 'claude' },
  ];
  const sends = [];
  mockHcom(t, { liveAgents, sends });
  eventsFixture = batchLaunched('waka', ['child1']);

  const { detectAndAdoptDescendants } = await import(`../dist/descendants.js?m37-${++importCounter}`);
  const { adopted } = await detectAndAdoptDescendants({
    records: readRegistry().records, liveAgents,
  });
  assert.deepEqual(adopted, []);
  assert.equal(readRegistry().records.filter((r) => r.hcomName === 'child1').length, 1);
});

test('whole tree via repetition: an adopted generation triggers on its own spawns', async (t) => {
  // Sweep N: waka spawns child1 (adopted). Sweep N+1: child1 (now managed)
  // spawns grandchild — same rule, no new logic.
  seedRegistry([makeRecord({ id: 'r1', hcomName: 'waka', launchedBy: 'nora' })]);
  let liveAgents = [
    { name: 'waka', base_name: 'waka', status: 'listening', tool: 'opencode' },
    { name: 'child1', base_name: 'child1', status: 'listening', tool: 'claude' },
  ];
  const sends = [];
  mockHcom(t, { liveAgents, sends });
  eventsFixture = batchLaunched('waka', ['child1']);

  const mod = () => import(`../dist/descendants.js?m37-${++importCounter}`);
  let { detectAndAdoptDescendants } = await mod();
  let records = readRegistry().records;
  await detectAndAdoptDescendants({ records, liveAgents });

  // Next sweep: the adopted generation's own spawn.
  eventsFixture = batchLaunched('child1', ['grandchild']);
  liveAgents = [...liveAgents, { name: 'grandchild', base_name: 'grandchild', status: 'listening', tool: 'opencode' }];
  ({ detectAndAdoptDescendants } = await mod());
  records = readRegistry().records;
  const { adopted } = await detectAndAdoptDescendants({ records, liveAgents });

  assert.deepEqual(adopted.map((a) => ({ name: a.name, hub: a.hub })), [
    { name: 'grandchild', hub: 'nora' },
  ]);
});

test('vanished or unknown-harness candidates are skipped without adoption', async (t) => {
  seedRegistry([makeRecord({ id: 'r1', hcomName: 'waka' })]);
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'listening', tool: 'opencode' }];
  const sends = [];
  mockHcom(t, { liveAgents, sends });
  eventsFixture = batchLaunched('waka', ['ghost', 'weirdtool']);

  const { detectAndAdoptDescendants } = await import(`../dist/descendants.js?m37-${++importCounter}`);
  const { adopted, skipped } = await detectAndAdoptDescendants({
    records: readRegistry().records, liveAgents,
  });
  assert.deepEqual(adopted, []);
  assert.equal(skipped.filter((s) => s.startsWith('ghost')).length, 1);
  assert.equal(skipped.filter((s) => s.startsWith('weirdtool')).length, 1);
});
