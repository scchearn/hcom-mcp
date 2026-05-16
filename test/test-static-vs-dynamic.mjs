import test from 'node:test';
import assert from 'node:assert/strict';

// Static import of hcom and launch — this will cache both
import * as hcomModule from '../dist/hcom.js';
import { registerLaunchTool } from '../dist/tools/launch.js';

const runUnsafeDemo = process.env.RUN_UNSAFE_HCOM_MOCK_DEMOS === '1';

function createFakeServer() {
  const names = [];
  const handlers = new Map();
  return {
    names,
    handlers,
    tool(name, _desc, _schema, handler) {
      this.names.push(name);
      this.handlers.set(name, handler);
    },
  };
}

(runUnsafeDemo ? test : test.skip)('static import + mock.module + dynamic import with cache-bust', async (t) => {
  let capturedArgs;
  t.mock.module('../dist/hcom.js', {
    namedExports: {
      execHcom: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: 'Names: test-agent\nBatch id: batch-123\n', stderr: '' };
      },
      listHarnessModels: async (harness) => {
        return [{ harness, status: 'live', source: 'mock', models: ['sonnet'], count: 1 }];
      },
    },
  });

  // Static registerLaunchTool uses real execHcom
  const server1 = createFakeServer();
  registerLaunchTool(server1);
  const response1 = await server1.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });
  console.log('static response:', response1);
  console.log('static capturedArgs:', capturedArgs); // undefined — real exec

  // Dynamic import with cache-bust URL
  const { registerLaunchTool: registerLaunchTool2 } = await import('../dist/tools/launch.js?' + Date.now());
  const server2 = createFakeServer();
  registerLaunchTool2(server2);
  const response2 = await server2.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });
  console.log('dynamic response:', response2);
  console.log('dynamic capturedArgs:', capturedArgs);

  // The key question: does dynamic import with cache-bust use the mock?
  assert.ok(!response2.isError);
  assert.ok(capturedArgs);
  assert.match(capturedArgs.join(' '), /--model sonnet/);
});
