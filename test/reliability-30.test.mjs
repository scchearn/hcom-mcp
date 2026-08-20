import test from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;

async function loadModule(path) {
  importCounter += 1;
  return import(`../dist/${path}?reliability30-${importCounter}`);
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

function sourceRecord(overrides = {}) {
  return {
    id: 'rec-source',
    workspace: '/repo',
    harness: 'opencode',
    hcomName: 'waka',
    preset: 'researcher',
    launchMode: 'headless',
    state: 'managed_stopped',
    createdAt: '2026-08-20T00:00:00.000Z',
    lastSeenAt: '2026-08-20T00:00:00.000Z',
    released: false,
    ...overrides,
  };
}

function mockResumeDeps(t, { records, execHcom, execCommand, upsertResumedRecord, addRecord }) {
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      resolveCallerName: async (override) => override,
      execHcom,
      execCommand,
    },
  });
  t.mock.module('../dist/registry.js', {
    namedExports: {
      getOwnedRecordsByWorkspace: () => records,
      upsertResumedRecord,
      addRecord,
    },
  });
}

test('headless OpenCode resume runs the retained session directly and updates its record', async (t) => {
  const calls = [];
  const commandCalls = [];
  const updates = [];
  const records = [sourceRecord()];

  mockResumeDeps(t, {
    records,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'list' && args[1] === '--stopped') {
        return {
          exitCode: 0,
          stdout: [
            'Stopped: waka',
            '  Tool:       opencode',
            '  Directory:  /original/workspace',
            '  Session:    ses_retain123',
          ].join('\n'),
          stderr: '',
        };
      }
      if (args[0] === 'events' && args[2] === '1') {
        return { exitCode: 0, stdout: '{"id":10,"type":"status","instance":"waka","data":{"status":"listening"}}', stderr: '' };
      }
      if (args[0] === 'events' && args[2] === '100') {
        return { exitCode: 0, stdout: '{"id":11,"type":"status","instance":"waka","data":{"status":"active"}}', stderr: '' };
      }
      throw new Error(`unexpected hcom args: ${args.join(' ')}`);
    },
    execCommand: async (command, args, options) => {
      commandCalls.push({ command, args, options });
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'step_start', sessionID: 'ses_retain123', timestamp: 1, part: { type: 'step-start' } }),
          JSON.stringify({ type: 'text', sessionID: 'ses_retain123', timestamp: 2, part: { type: 'text', text: 'report sent' } }),
          JSON.stringify({ type: 'step_finish', sessionID: 'ses_retain123', timestamp: 3, part: { type: 'step-finish' } }),
        ].join('\n'),
        stderr: '',
      };
    },
    upsertResumedRecord: (id, update) => {
      updates.push({ id, update });
      return { ...records[0], ...update, id };
    },
    addRecord: () => {
      throw new Error('headless resume must update the retained record');
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('resume')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    headless: true,
    prompt: 'Send the final report.',
  });

  assert.equal(response.isError, undefined);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.spawnedName, 'waka');
  assert.equal(payload.registryId, 'rec-source');
  assert.equal(commandCalls.length, 1);
  assert.equal(commandCalls[0].command, 'opencode');
  assert.deepEqual(commandCalls[0].args, [
    'run',
    '--session',
    'ses_retain123',
    '--format',
    'json',
    'Send the final report.',
  ]);
  assert.equal(commandCalls[0].options.cwd, '/original/workspace');
  assert.equal(commandCalls[0].options.env.HCOM_LAUNCHED, '1');
  assert.equal(commandCalls[0].options.env.HCOM_BACKGROUND, '1');
  assert.equal(commandCalls[0].options.env.HCOM_TOOL, 'opencode');
  assert.equal(commandCalls[0].options.env.HCOM_INSTANCE_NAME, 'waka');
  assert.match(commandCalls[0].options.env.HCOM_PROCESS_ID, /^hcom-mcp-resume-waka-/);
  assert.equal(calls.some((args) => args[0] === 'r'), false);
  assert.equal(calls.some((args) => args[0] === 'events'), false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'rec-source');
  assert.deepEqual({ ...updates[0].update, dispatchAt: undefined }, {
    hcomName: 'waka',
    sessionId: 'ses_retain123',
    state: 'managed_active',
    launchMode: 'headless',
    resumedFrom: 'waka',
    requireReport: false,
    dispatchAt: undefined,
  });
  assert.match(updates[0].update.dispatchAt, /^2026-/);
});

test('headless OpenCode resume refuses when no retained session id is available', async (t) => {
  let commandCalled = false;
  mockResumeDeps(t, {
    records: [sourceRecord()],
    execHcom: async (args) => {
      if (args[0] === 'list' && args[1] === '--stopped') {
        return { exitCode: 0, stdout: 'Stopped: waka\n  Tool:       opencode\n  Directory:  /original/workspace', stderr: '' };
      }
      throw new Error(`unexpected hcom args: ${args.join(' ')}`);
    },
    execCommand: async () => {
      commandCalled = true;
      throw new Error('execCommand should not run without a retained session');
    },
    upsertResumedRecord: () => {
      throw new Error('record should not update on invariant failure');
    },
    addRecord: () => {
      throw new Error('record should not append on invariant failure');
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('resume')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    headless: true,
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /^\[E_LAUNCH_FAILED\]/);
  assert.match(response.content[0].text, /retained OpenCode session/i);
  assert.equal(commandCalled, false);
});

test('headed resume refuses to claim readiness without active or response evidence', async (t) => {
  const calls = [];
  const records = [sourceRecord()];

  mockResumeDeps(t, {
    records,
    execHcom: async (args) => {
      calls.push(args);
      if (args[0] === 'events' && args[2] === '1') {
        return { exitCode: 0, stdout: '{"id":10,"type":"status","instance":"waka","data":{"status":"listening"}}', stderr: '' };
      }
      if (args[0] === 'events' && args[2] === '100') {
        return { exitCode: 0, stdout: '{"id":11,"type":"status","instance":"waka","data":{"status":"listening"}}', stderr: '' };
      }
      if (args[0] === 'r') {
        return { exitCode: 0, stdout: 'Names: waka\n', stderr: '' };
      }
      if (args[0] === 'events' && args[1] === '--wait') {
        return { exitCode: 2, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected hcom args: ${args.join(' ')}`);
    },
    execCommand: async () => {
      throw new Error('headed resume should use hcom');
    },
    upsertResumedRecord: (id, update) => ({ ...records[0], ...update, id }),
    addRecord: () => {
      throw new Error('headed resume must update the retained record');
    },
  });

  const { registerResumeForkTools } = await loadModule('tools/resume_fork.js');
  const server = createFakeServer();
  registerResumeForkTools(server);

  const response = await server.handlers.get('resume')({
    name: 'waka',
    workspace: '/repo',
    sender_name: 'nora',
    headless: false,
    prompt: 'Send the final report.',
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /could not prove.*consum/i);
  assert.ok(calls.some((args) => args[0] === 'r'));
});
