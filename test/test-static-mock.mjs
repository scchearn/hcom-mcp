import test from 'node:test';
import assert from 'node:assert/strict';

// Static import — this will be cached
import { registerLaunchTool } from '../dist/tools/launch.js';

const runUnsafeDemo = process.env.RUN_UNSAFE_HCOM_MOCK_DEMOS === '1';

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

(runUnsafeDemo ? test : test.skip)('static import + mock.module', async (t) => {
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

  // Try with static import (cached)
  const server1 = createFakeServer();
  registerLaunchTool(server1);
  const response1 = await server1.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });
  console.log('static response:', response1);
  console.log('static capturedArgs:', capturedArgs);

  // Try with dynamic import (new URL to bust cache)
  const { registerLaunchTool: registerLaunchTool2 } = await import('../dist/tools/launch.js?' + Date.now());
  const server2 = createFakeServer();
  registerLaunchTool2(server2);
  const response2 = await server2.handlers.get('launch')({
    harness: 'claude',
    model: 'sonnet',
  });
  console.log('dynamic response:', response2);
  console.log('dynamic capturedArgs:', capturedArgs);

  // Assertions for dynamic (should work)
  assert.ok(!response2.isError);
  assert.ok(capturedArgs);
  assert.match(capturedArgs.join(' '), /--model sonnet/);
});
