import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The cached dist/registry.js resolves REGISTRY_PATH at load — under the
// isolate-home preload that is the worker's temp root. Seed and read THAT
// file so sweeps (which use the same cached module) see the same data.
const { REGISTRY_PATH } = await import('../dist/registry.js?m2-base');
after(() => rmSync(join(REGISTRY_PATH, '..', '..'), { recursive: true, force: true }));

let importCounter = 0;

// Controllable clock: everything is measured from this fixed epoch.
const BASE = 1755700000000;
const iso = (ms) => new Date(ms).toISOString();
const sec = (n) => n * 1000;

async function loadSupervisor() {
  importCounter += 1;
  return import(`../dist/supervisor.js?m2-${importCounter}`);
}

function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    workspace: '/repo',
    harness: 'claude',
    hcomName: 'waka',
    preset: 'adhoc',
    launchMode: 'headless',
    state: 'managed_active',
    createdAt: iso(BASE - sec(60)),
    lastSeenAt: iso(BASE - sec(60)),
    released: false,
    launchedBy: 'nora',
    dispatchAt: iso(BASE),
    requireReport: false,
    ...overrides,
  };
}

function makeSupervision(overrides = {}) {
  return {
    hub: 'nora',
    policy: { enabled: true, attentionAfterSec: 180, escalateAfterSec: 360 },
    subscriptions: [],
    baselineAt: iso(BASE),
    ...overrides,
  };
}

function makeEvidence(overrides = {}) {
  return {
    liveAgent: { name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 200, unread_count: 0, tool: 'claude' },
    lastActivityAtMs: null,
    lastActivityKind: null,
    outstandingDispatch: true,
    wedgedQueue: false,
    ...overrides,
  };
}

// --- evaluateWorker: classification + alert budget + wake ladder ---

test('stalled_listening opens at the attention deadline with an attention alert and tier1', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const outcome = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision(),
    evidence: makeEvidence(),
    nowMs: BASE + sec(181),
  });
  assert.equal(outcome.supervision.incident.type, 'stalled_listening');
  assert.equal(outcome.notify.level, 'attention');
  assert.match(outcome.notify.text, /ATTENTION\] stalled_listening: waka/);
  assert.equal(outcome.tier1, true);
  assert.equal(outcome.tier2, undefined);
});

test('idle listening without outstanding work is never an incident', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const outcome = evaluateWorker({
    record: makeRecord({ requireReport: false }),
    supervision: makeSupervision(),
    evidence: makeEvidence({ outstandingDispatch: false }),
    nowMs: BASE + sec(3600),
  });
  assert.equal(outcome.supervision.incident, undefined);
  assert.equal(outcome.notify, undefined);
});

test('exactly one attention alert then one escalation alert per generation', async (t) => {
  const { evaluateWorker } = await loadSupervisor();

  // Open pass: attention (alertsSent 0 -> 1 after delivery).
  const open = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision(),
    evidence: makeEvidence(),
    nowMs: BASE + sec(181),
  });
  assert.equal(open.notify.level, 'attention');

  // Before the escalation deadline with the attention alert delivered: quiet.
  const mid = evaluateWorker({
    record: makeRecord(),
    supervision: { ...makeSupervision(), incident: { ...open.supervision.incident, alertsSent: 1 } },
    evidence: makeEvidence(),
    nowMs: BASE + sec(300),
  });
  assert.equal(mid.notify, undefined);

  // At the escalation deadline: exactly one escalation.
  const esc = evaluateWorker({
    record: makeRecord(),
    supervision: { ...makeSupervision(), incident: { ...open.supervision.incident, alertsSent: 1 } },
    evidence: makeEvidence(),
    nowMs: BASE + sec(361),
  });
  assert.equal(esc.notify.level, 'escalation');

  // After escalation was delivered: never a third alert.
  const late = evaluateWorker({
    record: makeRecord(),
    supervision: { ...makeSupervision(), incident: { ...open.supervision.incident, alertsSent: 2 } },
    evidence: makeEvidence(),
    nowMs: BASE + sec(7200),
  });
  assert.equal(late.notify, undefined);
});

test('a failed delivery retries the same level instead of advancing the budget', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const retry = evaluateWorker({
    record: makeRecord(),
    supervision: {
      ...makeSupervision(),
      incident: { type: 'stalled_listening', openedAt: iso(BASE + sec(181)), generation: iso(BASE), alertsSent: 0, deliveryFailed: true },
    },
    evidence: makeEvidence(),
    nowMs: BASE + sec(400),
  });
  assert.equal(retry.notify.level, 'attention');
});

test('newer meaningful activity resolves the incident and resets the window', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const outcome = evaluateWorker({
    record: makeRecord(),
    supervision: {
      ...makeSupervision(),
      incident: { type: 'stalled_listening', openedAt: iso(BASE + sec(181)), generation: iso(BASE), alertsSent: 1, deliveryFailed: false },
    },
    evidence: makeEvidence({ lastActivityAtMs: BASE + sec(400), lastActivityKind: 'report' }),
    nowMs: BASE + sec(500),
  });
  assert.equal(outcome.supervision.incident, undefined);
  assert.equal(outcome.notify, undefined);
  assert.equal(outcome.supervision.lastActivityKind, 'report');
});

test('blocked and lost are immediate and never run rescue tiers', async (t) => {
  const { evaluateWorker } = await loadSupervisor();

  const blocked = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision(),
    evidence: makeEvidence({ liveAgent: { name: 'waka', base_name: 'waka', status: 'blocked', status_age_seconds: 5, unread_count: 0, tool: 'claude' } }),
    nowMs: BASE + sec(10),
  });
  assert.equal(blocked.supervision.incident.type, 'blocked');
  assert.equal(blocked.notify.level, 'attention');
  assert.equal(blocked.tier1, undefined);

  const lost = evaluateWorker({
    record: makeRecord({ state: 'managed_lost' }),
    supervision: makeSupervision(),
    evidence: makeEvidence({ liveAgent: null }),
    nowMs: BASE + sec(10),
  });
  assert.equal(lost.supervision.incident.type, 'lost');
  assert.equal(lost.tier1, undefined);
});

test('a cleanly stopped worker is only an incident when a report was promised', async (t) => {
  const { evaluateWorker } = await loadSupervisor();

  const unreported = evaluateWorker({
    record: makeRecord({ state: 'managed_stopped', requireReport: true }),
    supervision: makeSupervision(),
    evidence: makeEvidence({ liveAgent: null }),
    nowMs: BASE + sec(10),
  });
  assert.equal(unreported.supervision.incident.type, 'stopped_unreported');

  const clean = evaluateWorker({
    record: makeRecord({ state: 'managed_stopped', requireReport: false }),
    supervision: makeSupervision(),
    evidence: makeEvidence({ liveAgent: null }),
    nowMs: BASE + sec(10),
  });
  assert.equal(clean.supervision.incident, undefined);
});

test('tier2 becomes eligible one escalation window after tier1, once per generation', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const incident = {
    type: 'stalled_listening',
    openedAt: iso(BASE + sec(181)),
    generation: iso(BASE),
    alertsSent: 1,
    deliveryFailed: false,
    tier1: { at: iso(BASE + sec(181)), outcome: 'tier1 wake sent' },
  };

  const tooSoon = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision({ incident }),
    evidence: makeEvidence(),
    nowMs: BASE + sec(181) + sec(359),
  });
  assert.equal(tooSoon.tier2, undefined);

  const due = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision({ incident }),
    evidence: makeEvidence(),
    nowMs: BASE + sec(181) + sec(360),
  });
  assert.equal(due.tier2, true);

  const alreadyDone = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision({ incident: { ...incident, tier2: { at: iso(BASE + sec(181) + sec(360)), outcome: 'injected' } } }),
    evidence: makeEvidence(),
    nowMs: BASE + sec(181) + sec(720),
  });
  assert.equal(alreadyDone.tier2, undefined);
});

// --- resolveRecordSupervision: sweep-side default ---

test('records without a supervision block default to supervised at resolved defaults', async (t) => {
  const { resolveRecordSupervision } = await loadSupervisor();

  // Legacy/resume/fork-style record: no block, defaults apply.
  const legacy = resolveRecordSupervision(makeRecord({ supervision: undefined }));
  assert.equal(legacy.policy.attentionAfterSec, 180);
  assert.equal(legacy.hub, 'nora');
  assert.equal(legacy.baselineAt, iso(BASE));

  // No launcher either: supervised but undeliverable (missing-hub retention).
  const orphan = resolveRecordSupervision(makeRecord({ supervision: undefined, launchedBy: undefined }));
  assert.equal(orphan.hub, '');

  // Adopted / headed / released records are not supervised.
  assert.equal(resolveRecordSupervision(makeRecord({ state: 'adopted_active' })), null);
  assert.equal(resolveRecordSupervision(makeRecord({ launchMode: 'headed' })), null);
  assert.equal(resolveRecordSupervision(makeRecord({ released: true })), null);
});

// --- runSupervisionSweep: driver over fixtures + fake clock ---

function seedRegistry(records) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ records }), 'utf-8');
}

function readRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
}

function mockHcomForSweep(t, { liveAgents, sends, unsubs = [], subList = '', agentEvents = '', inboundEvents = '' }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ?? id,
      parseHcomJson: JSON.parse,
      inferHarnessFromTool: (tool) => (tool === 'opencode' ? 'opencode' : tool === 'claude' ? 'claude' : null),
      listHcomAgents: async () => liveAgents,
      listStoppedAgentNames: async () => [],
      execHcom: async (args) => {
        if (args[0] === 'list') {
          return args.includes('--stopped')
            ? { exitCode: 0, stdout: '', stderr: '' }
            : { exitCode: 0, stdout: JSON.stringify(liveAgents), stderr: '' };
        }
        if (args[0] === 'events' && args[1] === 'sub') {
          if (args[2] === 'list') return { exitCode: 0, stdout: subList, stderr: '' };
          return { exitCode: 0, stdout: 'Subscription sub-bea0000 created', stderr: '' };
        }
        if (args[0] === 'events' && args[1] === 'unsub') {
          unsubs.push(args[2]);
          return { exitCode: 0, stdout: 'Removed', stderr: '' };
        }
        if (args[0] === 'events') {
          const isMention = args.includes('--mention');
          return { exitCode: 0, stdout: isMention ? inboundEvents : agentEvents, stderr: '' };
        }
        if (args[0] === 'send') {
          sends.push(args);
          return { exitCode: 0, stdout: 'Sent', stderr: '' };
        }
        if (args[0] === 'term') {
          return { exitCode: 0, stdout: JSON.stringify({ lines: ['screen line'] }), stderr: '' };
        }
        throw new Error(`unexpected hcom args: ${args.join(' ')}`);
      },
    },
  });
}

test('sweep supervises a legacy record, persists the incident before notifying, and runs tier1', async (t) => {
  const sends = [];
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 400, unread_count: 1, tool: 'claude' }];
  mockHcomForSweep(t, { liveAgents, sends });
  // Legacy: no supervision block at all — the sweep-side default applies.
  const seeded = makeRecord({ id: 'legacy-1', supervision: undefined });
  seedRegistry([seeded]);

  const { runSupervisionSweep } = await loadSupervisor();
  let now = BASE + sec(200);
  const summary = await runSupervisionSweep({
    now: () => now,
    reconcile: async () => ({ records: [seeded], liveAgents }),
  });

  assert.equal(summary.evaluated, 1);
  assert.equal(summary.incidentsOpened, 1);
  assert.equal(summary.alertsSent, 1);
  assert.equal(summary.tier1Attempts, 1);

  // Alert went to the resolved hub as a request; tier1 wake went to the worker.
  assert.ok(sends.some((a) => a[1] === '@nora' && a.includes('--intent') && a.includes('request')));
  assert.ok(sends.some((a) => a[1] === '@waka'));

  // Incident persisted on the record (persist-before-notify is enforced by
  // the single batched write covering both).
  const [record] = readRegistry().records;
  assert.equal(record.supervision.incident.type, 'stalled_listening');
  assert.equal(record.supervision.incident.alertsSent, 1);
  assert.match(record.supervision.incident.tier1.outcome, /tier1 wake sent/);

  // Second sweep past the escalation deadline: exactly one escalation, no
  // new incident, no duplicate tier1.
  now = BASE + sec(200) + sec(400);
  const summary2 = await runSupervisionSweep({ now: () => now });
  assert.equal(summary2.incidentsOpened, 0);
  assert.equal(summary2.alertsSent, 1);
  assert.equal(summary2.tier1Attempts, 0);
  const [record2] = readRegistry().records;
  assert.equal(record2.supervision.incident.alertsSent, 2);
});

test('sweep resolves an incident when meaningful activity appears, and retains undelivered incidents', async (t) => {
  const sends = [];
  const reportEvent = JSON.stringify({
    id: 11, ts: iso(BASE + sec(500)), type: 'message', instance: 'waka',
    data: { from: 'waka', intent: 'inform', text: 'progress report' },
  });
  mockHcomForSweep(t, {
    liveAgents: [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 5, unread_count: 0, tool: 'claude' }],
    sends,
    agentEvents: reportEvent,
  });

  // Pre-existing incident from an older generation.
  const seeded = makeRecord({
    id: 'rec-resolve',
    supervision: makeSupervision({
      incident: { type: 'stalled_listening', openedAt: iso(BASE + sec(181)), generation: iso(BASE), alertsSent: 1, deliveryFailed: false },
    }),
  });
  seedRegistry([seeded]);
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 5, unread_count: 0, tool: 'claude' }];

  const { runSupervisionSweep } = await loadSupervisor();
  const summary = await runSupervisionSweep({
    now: () => BASE + sec(600),
    reconcile: async () => ({ records: [seeded], liveAgents }),
  });

  assert.equal(summary.incidentsResolved, 1);
  assert.equal(summary.alertsSent, 0);
  const [record] = readRegistry().records;
  assert.equal(record.supervision.incident, undefined);
  assert.equal(record.supervision.lastActivityKind, 'report');
});

test('a missing hub retains the incident with deliveryFailed surfaced', async (t) => {
  const sends = [];
  const liveAgents = [{ name: 'orphan', base_name: 'orphan', status: 'active', status_age_seconds: 900, unread_count: 0, tool: 'claude' }];
  mockHcomForSweep(t, { liveAgents, sends });
  const seeded = makeRecord({ id: 'orphan-1', hcomName: 'orphan', launchedBy: undefined, supervision: undefined });
  seedRegistry([seeded]);

  const { runSupervisionSweep } = await loadSupervisor();
  const summary = await runSupervisionSweep({
    now: () => BASE + sec(200),
    reconcile: async () => ({ records: [seeded], liveAgents }),
  });

  assert.equal(summary.alertsFailed, 1);
  // No hub notification could go out, but the tier1 wake targets the
  // WORKER (in-band, non-destructive), not the hub — it still fires.
  assert.ok(sends.every((a) => a[1] === '@orphan'));
  const [record] = readRegistry().records;
  assert.equal(record.supervision.incident.type, 'stalled_active');
  assert.equal(record.supervision.incident.deliveryFailed, true);
});

// --- surfacing: watch poll + status expose open incidents ---

test('watch_agents poll lines and summary surface open incidents', async (t) => {
  seedRegistry([
    makeRecord({
      id: 'rec-incident',
      supervision: makeSupervision({
        incident: { type: 'stalled_listening', openedAt: iso(BASE + sec(181)), generation: iso(BASE), alertsSent: 1, deliveryFailed: false },
      }),
    }),
    makeRecord({ id: 'rec-clean', hcomName: 'zago' }),
  ]);
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => [
        { name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: null },
        { name: 'zago', base_name: 'zago', status: 'listening', status_age_seconds: 5, unread_count: 0, tag: null },
      ],
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ?? id,
      parseHcomJson: JSON.parse,
      resolveCallerName: async () => undefined,
      listStoppedAgentNames: async () => [],
      execHcom: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
  });

  const { registerWatchAgentsTool } = await import(`../dist/tools/watch.js?m2-${++importCounter}`);
  const server = { handlers: new Map(), tool(name, _d, _s, handler) { server.handlers.set(name, handler); } };
  registerWatchAgentsTool(server);

  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const payload = JSON.parse(response.content[0].text);
  const byName = Object.fromEntries(payload.agents.map((a) => [a.name, a]));
  assert.equal(byName.waka.incident.type, 'stalled_listening');
  assert.equal(byName.zago.incident, null);
  assert.equal(payload.summary.incidents, 1);
});

test('status exposes activeIncidents including undelivered ones', async (t) => {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      listHcomAgents: async () => [],
      listStoppedAgentNames: async () => [],
      parseHcomJson: JSON.parse,
      resolveCallerName: async () => undefined,
      execHcom: async (args) => {
        if (args[0] === '--version') return { exitCode: 0, stdout: 'hcom test', stderr: '' };
        if (args[0] === 'status') return { exitCode: 0, stdout: '{}', stderr: '' };
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getRecordsByWorkspace: () => [],
      getOwnedRecordsByWorkspace: () => [],
      reconcileGlobalRecords: async () => ({
        records: [
          makeRecord({
            id: 'inc-1',
            supervision: makeSupervision({
              incident: { type: 'blocked', openedAt: iso(BASE), generation: iso(BASE), alertsSent: 0, deliveryFailed: true },
            }),
          }),
        ],
        transitions: [],
        liveAgents: [],
        stoppedNames: [],
      }),
      matchLiveAgent: () => null,
      persistReconciledState: () => {},
      reconcileManagedRecords: (records) => records,
      resolveRootLauncher: (record) => record.launchedBy,
    },
  });
  t.mock.module('../dist/config.js', {
    namedExports: {
      loadMergedConfig: () => ({ agentPresets: {}, topologyPresets: {}, supervision: {} }),
      getConfigPaths: () => ({}),
      summarizeAgentPresets: () => [],
      summarizeTopologyPresets: () => [],
    },
  });

  const { registerStatusTool } = await import(`../dist/tools/list.js?m2-${++importCounter}`);
  const server = { handlers: new Map(), tool(name, _d, _s, handler) { server.handlers.set(name, handler); } };
  registerStatusTool(server);

  const response = await server.handlers.get('status')({ workspace: '/repo' });
  const payload = JSON.parse(response.content[0].text);
  assert.deepEqual(payload.activeIncidents, [{
    id: 'inc-1',
    hcomName: 'waka',
    type: 'blocked',
    openedAt: iso(BASE),
    alertsSent: 0,
    deliveryFailed: true,
  }]);
});

// --- M3: routine lifecycle informs + incident fingerprints ---

test('incident resolution sends exactly one recovered inform', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const resolved = evaluateWorker({
    record: makeRecord(),
    supervision: {
      ...makeSupervision(),
      incident: { type: 'stalled_listening', openedAt: iso(BASE + sec(181)), generation: iso(BASE), alertsSent: 1, deliveryFailed: false },
    },
    evidence: makeEvidence({ lastActivityAtMs: BASE + sec(400), lastActivityKind: 'report' }),
    nowMs: BASE + sec(500),
  });
  assert.equal(resolved.inform.kind, 'recovered');
  assert.match(resolved.inform.text, /RECOVERED.*waka/);

  // The next pass sees no incident and no pending inform — quiet.
  const after = evaluateWorker({
    record: makeRecord(),
    supervision: resolved.supervision,
    evidence: makeEvidence({ lastActivityAtMs: BASE + sec(400), lastActivityKind: 'work' }),
    nowMs: BASE + sec(600),
  });
  assert.equal(after.inform, undefined);
});

test('a cleanly stopped worker gets one completed inform per stopped episode', async (t) => {
  const { evaluateWorker } = await loadSupervisor();

  const first = evaluateWorker({
    record: makeRecord({ state: 'managed_stopped' }),
    supervision: makeSupervision(),
    evidence: makeEvidence({ liveAgent: null, outstandingDispatch: false }),
    nowMs: BASE + sec(30),
  });
  assert.equal(first.inform.kind, 'completed');
  assert.ok(first.supervision.cleanStopInformedAt);

  // Same episode: no repeat.
  const again = evaluateWorker({
    record: makeRecord({ state: 'managed_stopped' }),
    supervision: first.supervision,
    evidence: makeEvidence({ liveAgent: null, outstandingDispatch: false }),
    nowMs: BASE + sec(60),
  });
  assert.equal(again.inform, undefined);

  // Revival clears the marker; a later stop informs again.
  const revived = evaluateWorker({
    record: makeRecord(),
    supervision: again.supervision,
    evidence: makeEvidence(),
    nowMs: BASE + sec(90),
  });
  assert.equal(revived.supervision.cleanStopInformedAt, undefined);
});

test('opened incidents carry the worker:type:generation dedup fingerprint', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const outcome = evaluateWorker({
    record: makeRecord(),
    supervision: makeSupervision(),
    evidence: makeEvidence(),
    nowMs: BASE + sec(181),
  });
  assert.equal(outcome.supervision.incident.fingerprint, `waka:stalled_listening:${iso(BASE)}`);
});

// --- M4: rehydration, terminal cleanup, orphan reconciliation ---

test('rehydration reinstalls only subscription kinds hcom dropped, without duplicates', async (t) => {
  const sends = [];
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 5, unread_count: 0, tool: 'claude' }];
  // hcom still has the blocked sub; the life sub was lost (daemon restart).
  mockHcomForSweep(t, { liveAgents, sends, subList: 'sub-cafe111 blocked-agent\n' });
  const seeded = makeRecord({
    id: 'rec-rehydrate',
    supervision: makeSupervision({
      subscriptions: [
        { kind: 'life', subId: 'sub-gone9999' },
        { kind: 'blocked', subId: 'sub-cafe111' },
      ],
    }),
  });
  seedRegistry([seeded]);

  const { runSupervisionSweep } = await loadSupervisor();
  await runSupervisionSweep({
    now: () => BASE + sec(10),
    reconcile: async () => ({ records: [seeded], liveAgents }),
  });

  const [record] = readRegistry().records;
  const kinds = record.supervision.subscriptions.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ['blocked', 'life']);
  assert.equal(record.supervision.subscriptions.find((s) => s.kind === 'blocked').subId, 'sub-cafe111');
  assert.equal(record.supervision.subscriptions.find((s) => s.kind === 'life').subId, 'sub-bea0000');
});

test('a restart does not duplicate alerts: persisted budget survives a fresh module instance', async (t) => {
  const sends = [];
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 400, unread_count: 1, tool: 'claude' }];
  mockHcomForSweep(t, { liveAgents, sends });

  // Incident opened pre-restart with the attention alert already delivered.
  const seeded = makeRecord({
    id: 'rec-restart',
    supervision: makeSupervision({
      incident: {
        type: 'stalled_listening',
        openedAt: iso(BASE + sec(181)),
        generation: iso(BASE),
        alertsSent: 1,
        deliveryFailed: false,
        fingerprint: `waka:stalled_listening:${iso(BASE)}`,
      },
    }),
  });
  seedRegistry([seeded]);

  // Fresh module instance = simulated MCP restart.
  const { runSupervisionSweep } = await loadSupervisor();
  const summary = await runSupervisionSweep({
    now: () => BASE + sec(300), // past attention, before escalation
    reconcile: async () => ({ records: [seeded], liveAgents }),
  });

  assert.equal(summary.alertsSent, 0);
  assert.ok(!sends.some((a) => a[1] === '@nora'));
  const [record] = readRegistry().records;
  assert.equal(record.supervision.incident.alertsSent, 1);
});

test('confirmed terminal workers are unsubscribed and their push lane cleared', async (t) => {
  const sends = [];
  const unsubs = [];
  mockHcomForSweep(t, { liveAgents: [], sends, unsubs });
  seedRegistry([
    makeRecord({
      id: 'rec-terminal',
      state: 'managed_stopped',
      supervision: makeSupervision({
        subscriptions: [
          { kind: 'life', subId: 'sub-life777' },
          { kind: 'blocked', subId: 'sub-blk8888' },
        ],
      }),
    }),
  ]);

  const { runSupervisionSweep } = await loadSupervisor();
  const psummary = await runSupervisionSweep({
    now: () => BASE + sec(30),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: [] }),
  });
  assert.deepEqual(unsubs.sort(), ['sub-blk8888', 'sub-life777']);
  const [record] = readRegistry().records;
  assert.deepEqual(record.supervision.subscriptions, []);
  // The completed inform went out once for this episode.
  assert.ok(sends.some((a) => a[1] === '@nora' && a.join(' ').includes('COMPLETED')));
});

test('released records are reconciled: subscriptions removed, incident closed', async (t) => {
  const sends = [];
  const unsubs = [];
  mockHcomForSweep(t, { liveAgents: [], sends, unsubs });
  seedRegistry([
    makeRecord({
      id: 'rec-released',
      released: true,
      state: 'managed_released',
      supervision: makeSupervision({
        subscriptions: [{ kind: 'life', subId: 'sub-orphan99' }],
        incident: { type: 'lost', openedAt: iso(BASE), generation: iso(BASE), alertsSent: 1, deliveryFailed: false },
      }),
    }),
  ]);

  const { runSupervisionSweep } = await loadSupervisor();
  await runSupervisionSweep({
    now: () => BASE + sec(30),
    reconcile: async () => ({ records: [], liveAgents: [] }),
  });

  assert.deepEqual(unsubs, ['sub-orphan99']);
  const [record] = readRegistry().records;
  assert.deepEqual(record.supervision.subscriptions, []);
  assert.equal(record.supervision.incident, undefined);
});

test('OpenCode wedge evidence is reflected in incident diagnostics', async (t) => {
  const { evaluateWorker } = await loadSupervisor();
  const outcome = evaluateWorker({
    record: makeRecord({ harness: 'opencode' }),
    supervision: makeSupervision(),
    evidence: makeEvidence({ wedgedQueue: true }),
    nowMs: BASE + sec(181),
  });
  assert.equal(outcome.supervision.incident.type, 'stalled_listening');
  assert.match(outcome.notify.text, /wedged_queue evidence/);
});
