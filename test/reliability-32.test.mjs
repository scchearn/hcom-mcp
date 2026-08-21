import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

async function loadModule() {
  importCounter += 1;
  return import(`../dist/tools/watch.js?reliability32-${importCounter}`);
}

function createFakeServer() {
  const handlers = new Map();
  return {
    handlers,
    tool(name, _description, _schema, handler) {
      handlers.set(name, handler);
    },
  };
}

function record() {
  return {
    id: 'record-1',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    state: 'managed_active',
    createdAt: '2026-08-20T00:00:00.000Z',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    released: false,
    requireReport: true,
    dispatchAt: '2026-08-20T00:00:00.000Z',
  };
}

function mockWatchDeps(t, { agentEvents, inboundEvents, unreadCount = 0, execHcom }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      canonicalizeAgentName: (name) => name.replace(/^@/, ''),
      execHcom,
      findLiveAgentByIdentifier: (name, agents) =>
        agents.find((agent) => agent.name === name || agent.base_name === name) ?? null,
      listHcomAgents: async () => [{
        name: 'waka',
        base_name: 'waka',
        tool: 'opencode',
        status: 'listening',
        status_age_seconds: 0,
        unread_count: unreadCount,
        tag: null,
      }],
      parseHcomJson: JSON.parse,
      resolveCallerName: async (override) => override,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => [record()],
      resolveRootLauncher: (record) => record.launchedBy,
    },
  });
  return { agentEvents, inboundEvents };
}

test('watch_agents flags an OpenCode queue wedged for exactly 600 seconds and fetches term only then', async (t) => {
  const dispatchAt = new Date(Date.now() - 600_000).toISOString().slice(0, 19);
  const calls = [];
  const inboundEvents = [
    {
      id: 124623,
      instance: 'rira',
      ts: dispatchAt,
      type: 'message',
      data: { from: 'rira', intent: 'request', text: 'process the queued task' },
    },
  ];
  const agentEvents = [
    {
      id: 124624,
      instance: 'waka',
      ts: new Date().toISOString().slice(0, 19),
      type: 'status',
      data: { status: 'listening', context: 'idle', new_status: 'listening', new_context: 'idle' },
    },
  ];
  mockWatchDeps(t, {
    agentEvents,
    inboundEvents,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args.includes('--mention')) {
        return { exitCode: 0, stdout: inboundEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      if (args[0] === 'events' && args.includes('--agent')) {
        return { exitCode: 0, stdout: agentEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      if (args[0] === 'term') {
        return { exitCode: 0, stdout: JSON.stringify({ lines: ['queued prompt', 'listening'] }), stderr: '' };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  const agent = payload.agents[0];
  assert.ok(agent.flags.includes('wedged_queue'));
  assert.equal(agent.wedgedQueue.evidenceTimestamp, dispatchAt);
  assert.equal(agent.wedgedQueue.dispatchIntent, 'request');
  assert.ok(agent.wedgedQueue.ageSeconds >= 600);
  assert.match(agent.wedgedQueue.termTail, /listening/);
  assert.equal(payload.summary.wedged_queue, 1);
  assert.equal(calls.filter((args) => args[0] === 'term').length, 1);
  assert.equal(calls.some((args) => args[0] === 'stop' || args[0] === 'kill'), false);
  assert.ok(calls.some((args) => args.includes('--mention') && args.includes('waka')));
  assert.ok(calls.some((args) => args.includes('--agent') && args.includes('waka')));
  assert.equal(calls.some((args) => args.includes('--mention') && args.includes('--agent')), false);
  assert.equal(agent.report.required, true);
});

test('watch_agents treats old inbound inform as a candidate but ignores ack traffic', async (t) => {
  const old = new Date(Date.now() - 900_000).toISOString().slice(0, 19);
  const calls = [];
  const inboundEvents = [
    { id: 124630, type: 'message', instance: 'rira', ts: old, data: { from: 'rira', intent: 'inform', text: 'FYI' } },
    { id: 124631, type: 'message', instance: 'rira', ts: old, data: { from: 'rira', intent: 'ack', text: 'acknowledged' } },
  ];
  const agentEvents = [];
  mockWatchDeps(t, {
    agentEvents,
    inboundEvents,
    unreadCount: 3,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args.includes('--mention')) {
        return { exitCode: 0, stdout: inboundEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      if (args[0] === 'events' && args.includes('--agent')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'term') return { exitCode: 0, stdout: JSON.stringify({ lines: ['listening'] }), stderr: '' };
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const agent = JSON.parse(response.content[0].text).agents[0];

  assert.equal(agent.flags.includes('wedged_queue'), true);
  assert.equal(agent.wedgedQueue.dispatchIntent, 'inform');
  assert.equal(agent.flags.includes('unreported'), true);
  assert.equal(calls.some((args) => args[0] === 'term'), true);
});

test('watch_agents clears wedged_queue when the agent replies after dispatch', async (t) => {
  const old = new Date(Date.now() - 900_000).toISOString().slice(0, 19);
  const reply = new Date().toISOString().slice(0, 19);
  const calls = [];
  const inboundEvents = [
    { id: 124640, type: 'message', instance: 'rira', ts: old, data: { from: 'rira', intent: 'request', text: 'do work' } },
  ];
  const agentEvents = [
    { id: 124641, type: 'message', instance: 'waka', ts: reply, data: { from: 'waka', intent: 'inform', text: 'received' } },
  ];
  mockWatchDeps(t, {
    agentEvents,
    inboundEvents,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args.includes('--mention')) {
        return { exitCode: 0, stdout: inboundEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      if (args[0] === 'events' && args.includes('--agent')) {
        return { exitCode: 0, stdout: agentEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      throw new Error(`term must not run after consumption evidence: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const agent = JSON.parse(response.content[0].text).agents[0];

  assert.equal(agent.flags.includes('wedged_queue'), false);
  assert.equal(calls.some((args) => args[0] === 'term'), false);
});

test('watch_agents clears wedged_queue when post-dispatch activity proves consumption', async (t) => {
  const old = new Date(Date.now() - 900_000).toISOString().slice(0, 19);
  const active = new Date(Date.now() - 899_000).toISOString().slice(0, 19);
  const calls = [];
  const inboundEvents = [
    { id: 124650, type: 'message', instance: 'rira', ts: old, data: { from: 'rira', intent: 'request', text: 'do work' } },
  ];
  const agentEvents = [
    { id: 124651, type: 'status', instance: 'waka', ts: active, data: { status: 'active', context: 'tool:read', new_status: 'active', new_context: 'tool:read' } },
  ];
  mockWatchDeps(t, {
    agentEvents,
    inboundEvents,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args.includes('--mention')) {
        return { exitCode: 0, stdout: inboundEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      if (args[0] === 'events' && args.includes('--agent')) {
        return { exitCode: 0, stdout: agentEvents.map((event) => JSON.stringify(event)).join('\n'), stderr: '' };
      }
      throw new Error(`term must not run after activity evidence: ${args.join(' ')}`);
    },
  });

  const { registerWatchAgentsTool } = await loadModule();
  const server = createFakeServer();
  registerWatchAgentsTool(server);
  const response = await server.handlers.get('watch_agents')({ workspace: '/repo' });
  const agent = JSON.parse(response.content[0].text).agents[0];

  assert.equal(agent.flags.includes('wedged_queue'), false);
  assert.equal(calls.some((args) => args[0] === 'term'), false);
});
