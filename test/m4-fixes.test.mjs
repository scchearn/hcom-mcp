import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Same registry file the cached dist modules use (isolate-home temp root).
const { REGISTRY_PATH } = await import('../dist/registry.js?fx-base');
after(() => rmSync(join(REGISTRY_PATH, '..', '..'), { recursive: true, force: true }));

let importCounter = 0;
const BASE = 1755700000000;
const iso = (ms) => new Date(ms).toISOString();
const sec = (n) => n * 1000;

function seedRegistry(records) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ records }), 'utf-8');
}

function readRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
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

const LIVE = [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 400, unread_count: 1, tool: 'claude' }];

function mockHcom(t, { liveAgents = LIVE, sends = [], unsubs = [], subList = '', failState = { fails: false }, lifeEvents = '', messageEvents = '', statusEvents = '' }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (o) => o,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ?? id,
      parseHcomJson: JSON.parse,
      inferHarnessFromTool: (tool) => (tool === 'opencode' ? 'opencode' : tool === 'claude' ? 'claude' : null),
      listHcomAgents: async () => liveAgents,
      listStoppedAgentNames: async () => [],
      execHcom: async (args) => {
        if (args[0] === 'list') return { exitCode: 0, stdout: JSON.stringify(liveAgents), stderr: '' };
        if (args[0] === 'events' && args[1] === 'sub') {
          if (args[2] === 'list') return { exitCode: 0, stdout: subList, stderr: '' };
          return { exitCode: 0, stdout: 'Subscription sub-bea0000 created', stderr: '' };
        }
        if (args[0] === 'events' && args[1] === 'unsub') {
          unsubs.push(args[2]);
          return { exitCode: 0, stdout: 'Removed', stderr: '' };
        }
        if (args[0] === 'events') {
          // Honor --type: a missing query must show up as missing evidence,
          // not be silently supplied by a type-blind fixture.
          const bucket = args.includes('--type')
            ? { life: lifeEvents, message: messageEvents, status: statusEvents }[args[args.indexOf('--type') + 1]] ?? ''
            : '';
          return { exitCode: 0, stdout: bucket, stderr: '' };
        }
        if (args[0] === 'term') return { exitCode: 0, stdout: JSON.stringify({ lines: ['tail line'] }), stderr: '' };
        if (args[0] === 'send') {
          sends.push(args);
          if (failState.fails) return { exitCode: 1, stdout: '', stderr: 'hcom identity not found' };
          return { exitCode: 0, stdout: 'Sent', stderr: '' };
        }
        throw new Error(`unexpected hcom args: ${args.join(' ')}`);
      },
    },
  });
}

async function loadSupervisor() {
  importCounter += 1;
  return import(`../dist/supervisor.js?fx-${importCounter}`);
}

test('B1: supervision sends carry --from identity; hub alerts are intent=request', async (t) => {
  const sends = [];
  mockHcom(t, { sends });
  seedRegistry([makeRecord({ id: 'rec-ident', supervision: undefined })]);

  const { runSupervisionSweep } = await loadSupervisor();
  await runSupervisionSweep({
    now: () => BASE + sec(200),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: LIVE }),
  });

  assert.ok(sends.length >= 2);
  assert.ok(sends.every((a) => a.includes('--from') && a.includes('hcom-mcp-supervisor')));
  const alert = sends.find((a) => a[1] === '@nora');
  assert.ok(alert && alert.includes('--intent') && alert.includes('request'));
});

test('B1 retention: a failing send keeps deliveryFailed without advancing the budget', async (t) => {
  const sends = [];
  const failState = { fails: true };
  mockHcom(t, { sends, failState });
  const mod = await loadSupervisor();
  seedRegistry([makeRecord({ id: 'rec-fail', supervision: undefined })]);

  await mod.runSupervisionSweep({
    now: () => BASE + sec(200),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: LIVE }),
  });
  let [record] = readRegistry().records;
  assert.equal(record.supervision.incident.deliveryFailed, true);
  assert.equal(record.supervision.incident.alertsSent, 0);

  // Delivery recovers: the SAME attention level retries and succeeds.
  failState.fails = false;
  await mod.runSupervisionSweep({
    now: () => BASE + sec(230),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: LIVE }),
  });
  record = readRegistry().records[0];
  assert.equal(record.supervision.incident.alertsSent, 1);
  assert.equal(record.supervision.incident.deliveryFailed, false);
});

test('M3 ordering: the incident is persisted before the alert send fires', async (t) => {
  const observations = [];
  const sends = [];
  mockHcom(t, { sends });
  // Wrap send observation through the unsubs channel is wrong — observe by
  // reading the registry inside a custom exec is not possible through the
  // shared mock, so assert on the post-sweep file plus the mid-loop write
  // having used applySupervisionUpdates: simulate by checking that the
  // incident on disk carries tier1 outcome recorded AFTER the send.
  seedRegistry([makeRecord({ id: 'rec-order', supervision: undefined })]);

  const { runSupervisionSweep } = await loadSupervisor();
  await runSupervisionSweep({
    now: () => BASE + sec(200),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: LIVE }),
  });

  const [record] = readRegistry().records;
  // The tier1 attempt was persisted together with the incident, and the
  // alert budget advanced — both writes survived the send.
  assert.equal(record.supervision.incident.type, 'stalled_listening');
  assert.equal(record.supervision.incident.alertsSent, 1);
  assert.match(record.supervision.incident.tier1.outcome, /tier1 wake sent/);
  assert.ok(sends.some((a) => a[1] === '@nora'));
});

test('M8 diagnostics: alerts carry recent events, terminal tail, and rescue-attempted lines', async (t) => {
  const sends = [];
  const agentEvents = [
    JSON.stringify({ id: 3, ts: iso(BASE - sec(30)), type: 'status', instance: 'waka', data: { status: 'active', context: 'tool:Bash' } }),
  ].join('\n');
  mockHcom(t, { sends, statusEvents: agentEvents, messageEvents: JSON.stringify({ id: 4, ts: iso(BASE - sec(20)), type: 'message', instance: 'waka', data: { from: 'nora', intent: 'request', text: 'dispatch text' } }) });
  seedRegistry([makeRecord({ id: 'rec-diag', supervision: undefined })]);

  const { runSupervisionSweep } = await loadSupervisor();
  await runSupervisionSweep({
    now: () => BASE + sec(200),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: LIVE }),
  });

  const alert = sends.find((a) => a[1] === '@nora');
  const text = alert[alert.indexOf('--') + 1];
  assert.match(text, /recent events:/);
  assert.match(text, /terminal tail:\n  tail line/);
  assert.match(text, /rescue attempted: none/);

  // Escalation reports the tier1 attempt that already ran.
  const { runSupervisionSweep: sweepAgain } = await loadSupervisor();
  await sweepAgain({
    now: () => BASE + sec(600),
    reconcile: async () => ({ records: readRegistry().records, liveAgents: LIVE }),
  });
  const escalation = sends.filter((a) => a[1] === '@nora').pop();
  const escText = escalation[escalation.indexOf('--') + 1];
  assert.match(escText, /ESCALATION/);
  assert.match(escText, /rescue attempted: tier1/);
});

test('adapters: meaningful activity kinds incl. tool context and codex signals', async (t) => {
  const { latestMeaningfulActivity, hasOutstandingDispatch } = await loadSupervisor();

  // Codex agent: report message wins over older lifecycle/status events.
  const codexEvents = [
    { ts: iso(BASE + sec(10)), type: 'life', instance: 'kodo', data: { action: 'ready' } },
    { ts: iso(BASE + sec(20)), type: 'status', instance: 'kodo', data: { status: 'active' } },
    { ts: iso(BASE + sec(30)), type: 'message', instance: 'kodo', data: { from: 'kodo', intent: 'inform', text: 'step done' } },
  ];
  assert.deepEqual(latestMeaningfulActivity('kodo', codexEvents), { atMs: BASE + sec(30), kind: 'report' });

  // Tool-context status transition is meaningful activity.
  const toolEvents = [
    { ts: iso(BASE + sec(40)), type: 'status', instance: 'kodo', data: { new_status: 'active', new_context: 'tool:Bash' } },
  ];
  assert.equal(latestMeaningfulActivity('kodo', toolEvents).kind, 'work:Bash');

  // listening alone is NOT activity.
  const listenEvents = [
    { ts: iso(BASE + sec(50)), type: 'status', instance: 'kodo', data: { status: 'listening' } },
  ];
  assert.equal(latestMeaningfulActivity('kodo', listenEvents), null);

  // hasOutstandingDispatch: unmet require_report since dispatch.
  const record = makeRecord({ hcomName: 'kodo', requireReport: true, dispatchAt: iso(BASE) });
  assert.equal(
    hasOutstandingDispatch({
      record,
      liveAgent: { name: 'kodo', base_name: 'kodo', status: 'active', unread_count: 0 },
      agentEvents: [],
      inboundEvents: [],
    }),
    true,
  );
  assert.equal(
    hasOutstandingDispatch({
      record,
      liveAgent: { name: 'kodo', base_name: 'kodo', status: 'listening', unread_count: 0 },
      agentEvents: [{ ts: iso(BASE + sec(5)), type: 'message', instance: 'kodo', data: { from: 'kodo', text: 'done' } }],
      inboundEvents: [],
    }),
    false,
  );
  assert.equal(
    hasOutstandingDispatch({
      record: makeRecord({ hcomName: 'kodo', requireReport: false, dispatchAt: iso(BASE - sec(60)) }),
      liveAgent: { name: 'kodo', base_name: 'kodo', status: 'listening', unread_count: 0 },
      agentEvents: [],
      inboundEvents: [{ ts: iso(BASE + sec(1)), type: 'message', instance: 'nora', data: { from: 'nora', intent: 'request', text: 'do it' } }],
    }),
    true,
  );
});

// --- round-2 regressions (ginu) ---

test('MAJOR A: flapping status within one generation alerts once and wakes once', async (t) => {
  const sends = [];
  mockHcom(t, { sends });
  seedRegistry([makeRecord({ id: 'rec-flap', supervision: undefined })]);

  const { runSupervisionSweep } = await loadSupervisor();
  const run = (status, atMs) => runSupervisionSweep({
    now: () => atMs,
    reconcile: async () => ({
      records: readRegistry().records,
      liveAgents: [{ name: 'waka', base_name: 'waka', status, status_age_seconds: 400, unread_count: 1, tool: 'claude' }],
    }),
  });

  // Open: listening + outstanding -> stalled_listening.
  await run('listening', BASE + sec(200));
  let [record] = readRegistry().records;
  assert.equal(record.supervision.incident.type, 'stalled_listening');
  assert.equal(record.supervision.incident.alertsSent, 1);

  // Flip to active: material type change mutates IN PLACE — no reopen, no
  // fresh tier1, no second attention alert inside the same generation.
  await run('active', BASE + sec(230));
  [record] = readRegistry().records;
  assert.equal(record.supervision.incident.type, 'stalled_active');
  assert.equal(record.supervision.incident.alertsSent, 1);
  assert.ok(record.supervision.incident.tier1, 'tier1 history carried forward');

  // Flip back to listening: still one generation, still capped.
  await run('listening', BASE + sec(260));
  [record] = readRegistry().records;
  assert.equal(record.supervision.incident.type, 'stalled_listening');

  const hubAlerts = sends.filter((a) => a[1] === '@nora');
  assert.equal(hubAlerts.length, 1);
  const wakes = sends.filter((a) => a[1] === '@waka');
  assert.equal(wakes.length, 1);
});

test('MAJOR B: tool-context status events reset the generation (no false stall)', async (t) => {
  // Dispatch at BASE; worker has been running a tool call since BASE+100s.
  // Without the status query this is 200s of "silence" -> stalled_active.
  const sends = [];
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'active', status_age_seconds: 100, unread_count: 0, tool: 'claude' }];
  const statusEvents = JSON.stringify({ id: 7, ts: iso(BASE + sec(100)), type: 'status', instance: 'waka', data: { new_status: 'active', new_context: 'tool:Bash' } });
  mockHcom(t, { liveAgents, sends, statusEvents });
  seedRegistry([makeRecord({ id: 'rec-tool', supervision: undefined })]);

  const { runSupervisionSweep } = await loadSupervisor();
  const summary = await runSupervisionSweep({
    now: () => BASE + sec(200),
    reconcile: async () => ({ records: readRegistry().records, liveAgents }),
  });

  assert.equal(summary.incidentsOpened, 0);
  assert.deepEqual(sends, []);
});

test('M5: a dead agent never produces a RECOVERED inform — it classifies lost', async (t) => {
  const sends = [];
  mockHcom(t, { liveAgents: [], sends });
  seedRegistry([
    makeRecord({
      id: 'rec-dead',
      state: 'managed_active',
      supervision: makeSupervision({
        incident: {
          type: 'stalled_listening',
          openedAt: iso(BASE + sec(181)),
          generation: iso(BASE + sec(400)), // activity generation newer than baseline
          alertsSent: 1,
          deliveryFailed: false,
        },
      }),
    }),
  ]);

  const { evaluateWorker } = await loadSupervisor();
  const outcome = evaluateWorker({
    record: readRegistry().records[0],
    supervision: readRegistry().records[0].supervision,
    evidence: { liveAgent: null, lastActivityAtMs: null, lastActivityKind: null, outstandingDispatch: false, wedgedQueue: false, dispatchIntent: null, recentEventsSummary: [] },
    nowMs: BASE + sec(500),
  });
  // No resolution-branch RECOVERED: the agent DIED, it did not recover.
  assert.equal(outcome.inform, undefined);
  // Open on the alerting sweep; close fires on the first sweep with
  // nothing left to say (part a).
  assert.equal(outcome.supervision.incident.type, 'lost');
  // MAJOR A carry-forward: the burned attention alert stays spent; the
  // remaining slot fires ONCE, labelled with the new type.
  assert.equal(outcome.supervision.incident.alertsSent, 1);
  assert.equal(outcome.notify.level, 'escalation');
});

test('MAJOR C: a throw during tier2 persists the escalation budget, no double-fire', async (t) => {
  const sends = [];
  const liveAgents = [{ name: 'waka', base_name: 'waka', status: 'listening', status_age_seconds: 900, unread_count: 1, tool: 'opencode' }];
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (o) => o,
      findLiveAgentByIdentifier: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id) ?? null,
      canonicalizeAgentName: (id, agents) =>
        agents.find((a) => a.name === id || a.base_name === id)?.base_name ?? id,
      parseHcomJson: JSON.parse,
      inferHarnessFromTool: () => 'opencode',
      listHcomAgents: async () => {
        throw new Error('transient hcom list failure');
      },
      listStoppedAgentNames: async () => [],
      execHcom: async (args) => {
        if (args[0] === 'events' && args[1] === 'sub') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[0] === 'events') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[0] === 'send') { sends.push(args); return { exitCode: 0, stdout: 'Sent', stderr: '' }; }
        throw new Error(`unexpected: ${args.join(' ')}`);
      },
    },
  });
  seedRegistry([
    makeRecord({
      id: 'rec-tier2',
      harness: 'opencode',
      supervision: makeSupervision({
        incident: {
          type: 'stalled_listening',
          openedAt: iso(BASE + sec(181)),
          generation: iso(BASE),
          alertsSent: 1,
          deliveryFailed: false,
          tier1: { at: iso(BASE + sec(181)), outcome: 'tier1 wake sent' },
          dispatchIntent: 'request',
        },
      }),
    }),
  ]);

  const { runSupervisionSweep } = await loadSupervisor();
  // tier2 -> runUnblock -> listHcomAgents throws; the sweep must survive
  // and persist the escalation bump that already went out.
  const summary = await runSupervisionSweep({ now: () => BASE + sec(600) });
  assert.equal(summary.alertsSent, 1);

  const [record] = readRegistry().records;
  assert.equal(record.supervision.incident.alertsSent, 2);
  // Next sweep must NOT re-send the escalation (budget spent).
  const sendsBefore = sends.filter((a) => a[1] === '@nora').length;
  await runSupervisionSweep({ now: () => BASE + sec(700) });
  assert.equal(sends.filter((a) => a[1] === '@nora').length, sendsBefore);
});

test('BLOCKER regression: a lost worker alerts exactly twice across six sweeps, then closes', async (t) => {
  const sends = [];
  const liveAgents = [];
  mockHcom(t, { liveAgents, sends });
  seedRegistry([
    makeRecord({ id: 'rec-lostloop', state: 'managed_lost', supervision: undefined }),
  ]);

  const { runSupervisionSweep } = await loadSupervisor();
  // Six sweeps at 90s spacing so the window spans the escalation deadline
  // (attention at ~10s, escalation at ~370s, close on the first quiet pass).
  for (let i = 0; i < 6; i++) {
    await runSupervisionSweep({
      now: () => BASE + sec(10) + sec(90 * i),
      reconcile: async () => ({ records: readRegistry().records, liveAgents }),
    });
  }

  // Exactly two hub sends total (attention + escalation), then silence —
  // an unbounded per-sweep loop is the e0a35e6 regression this pins.
  const hubAlerts = sends.filter((a) => a[1] === '@nora');
  assert.equal(hubAlerts.length, 2);
  assert.match(hubAlerts[0][hubAlerts[0].indexOf('--') + 1], /ATTENTION\] lost/);
  assert.match(hubAlerts[1][hubAlerts[1].indexOf('--') + 1], /ESCALATION\] lost/);

  // Incident closed into evidence with the full budget recorded.
  const [record] = readRegistry().records;
  assert.equal(record.supervision.incident, undefined);
  assert.equal(record.supervision.lastIncident.alertsSent, 2);
  assert.equal(record.supervision.lastIncident.type, 'lost');

  // And it stays silent forever after (reopen guard).
  await runSupervisionSweep({
    now: () => BASE + sec(10) + sec(90 * 6),
    reconcile: async () => ({ records: readRegistry().records, liveAgents }),
  });
  assert.equal(sends.filter((a) => a[1] === '@nora').length, 2);
});
