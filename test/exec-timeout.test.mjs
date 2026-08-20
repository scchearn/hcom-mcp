import test from 'node:test';
import assert from 'node:assert/strict';
import { execCommand } from '../dist/hcom.js';

test('execCommand honors a per-call timeoutMs and reports timedOut', async () => {
  const result = await execCommand('node', ['-e', 'setTimeout(() => {}, 5000)'], {
    timeoutMs: 300,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.timedOut, true);
});

test('execCommand hands off a long-running child without killing it', async () => {
  const result = await execCommand('node', ['-e', 'setTimeout(() => {}, 500)'], {
    handoffTimeoutMs: 25,
  });

  assert.equal(result.exitCode, -1);
  assert.equal(result.handedOff, true);
  assert.equal(result.timedOut, undefined);
  assert.equal(typeof result.pid, 'number');
});

test('execCommand does not report timedOut for a normal nonzero exit', async () => {
  const result = await execCommand('node', ['-e', 'process.exit(3)']);

  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, undefined);
});

test('execCommand returns exitCode 0 for a successful command', async () => {
  const result = await execCommand('node', ['-e', 'console.log("ok")']);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.timedOut, undefined);
});

test('execCommand maps a missing binary to exitCode 1, not a string code', async () => {
  const result = await execCommand('definitely-not-a-real-binary-xyz', []);

  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, undefined);
});
