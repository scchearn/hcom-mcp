import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLaunchTool } from '../dist/tools/launch.js';
import { reconcileManagedRecords } from '../dist/tools/list.js';

let importCounter = 0;

async function loadLaunchModule() {
  importCounter += 1;
  return import(`../dist/tools/launch.js?${importCounter}`);
}

function createFakeServer() {
  const names = [];
  const handlers = new Map();
  return {
    names,
    handlers,
    tool(name, _description, _schema, handler) {
      names.push(name);
      handlers.set(name, handler);
    },
  };
}

function baseRecord(overrides = {}) {
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

function mockLaunchDeps(t, { execHcom, addRecord, removeRecords }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom: execHcom,
      listHarnessModels: async (harness) => {
        const models = { claude: ['sonnet'], opencode: ['opencode/deepseek-v4-flash-free'] };
        const available = models[harness] || [];
        return [{ harness, status: 'live', source: 'mock', models: available, count: available.length }];
      },
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      addRecord: addRecord,
      removeRecords: removeRecords ?? (() => {}),
    },
  });
}

test('launch exit 0 records managed_active and persists batchId', async (t) => {
  const added = [];
  mockLaunchDeps(t, {
    execHcom: async () => ({ exitCode: 0, stdout: 'Names: waka\nBatch id: batch-77\n', stderr: '' }),
    addRecord: (record) => {
      added.push(record);
      return { ...record, id: `record-${added.length}` };
    },
  });

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.ok(!response.isError, response?.content?.[0]?.text);
  assert.equal(added.length, 1);
  assert.equal(added[0].state, 'managed_active');
  assert.equal(added[0].batchId, 'batch-77');
  assert.equal(added[0].hcomName, 'waka');
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.batchId, 'batch-77');
});

test('launch exit 2 with names records managed_blocked and returns a non-error with a term hint', async (t) => {
  const added = [];
  mockLaunchDeps(t, {
    execHcom: async () => ({ exitCode: 2, stdout: 'Names: waka\nBatch id: batch-9\n', stderr: '' }),
    addRecord: (record) => {
      added.push(record);
      return { ...record, id: `record-${added.length}` };
    },
  });

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.equal(response.isError, undefined);
  assert.equal(added.length, 1);
  assert.equal(added[0].state, 'managed_blocked');
  assert.equal(added[0].batchId, 'batch-9');
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.blocked, true);
  assert.match(payload.reason, /hcom term waka/);
  assert.match(payload.reason, /managed_blocked/);
});

test('launch exit 1 with names records managed_lost, kills the corpse, and errors', async (t) => {
  const added = [];
  const killTargets = [];
  mockLaunchDeps(t, {
    execHcom: async (args) => {
      if (args[0] === 'kill') {
        killTargets.push(args[1]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: 'Names: waka\nBatch id: batch-1\n', stderr: 'spawn failed' };
    },
    addRecord: (record) => {
      added.push(record);
      return { ...record, id: `record-${added.length}` };
    },
  });

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.equal(added.length, 1);
  assert.equal(added[0].state, 'managed_lost');
  assert.match(response.content[0].text, /managed_lost/);
  assert.deepEqual(killTargets, ['waka']);
});

test('launch exit 1 without names records nothing and errors', async (t) => {
  let addRecordCalls = 0;
  mockLaunchDeps(t, {
    execHcom: async () => ({ exitCode: 1, stdout: '', stderr: 'spawn failed' }),
    addRecord: () => {
      addRecordCalls += 1;
      throw new Error('addRecord should not be called when nothing was spawned');
    },
  });

  const { registerLaunchTool } = await loadLaunchModule();
  const server = createFakeServer();
  registerLaunchTool(server);

  const response = await server.handlers.get('launch')({
    harness: 'opencode',
    model: 'opencode/deepseek-v4-flash-free',
    sender_name: 'nora',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /spawn failed/);
  assert.equal(addRecordCalls, 0);
});

test('reconcile promotes a blocked record to active when the agent is live again', () => {
  const records = [baseRecord({ id: '1', state: 'managed_blocked' })];
  const reconciled = reconcileManagedRecords(records, [
    { name: 'waka', base_name: 'waka', status: 'listening' },
  ]);
  assert.equal(reconciled[0].state, 'managed_active');
});

test('reconcile demotes a blocked record to lost when the agent is gone', () => {
  const records = [baseRecord({ id: '1', state: 'managed_blocked' })];
  const reconciled = reconcileManagedRecords(records, []);
  assert.equal(reconciled[0].state, 'managed_lost');
});
