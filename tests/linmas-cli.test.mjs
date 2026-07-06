import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../bin/linmas.mjs';

function createMockIO() {
  let stdoutData = '';
  let stderrData = '';
  return {
    stdout: {
      write(chunk) {
        stdoutData += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderrData += chunk;
        return true;
      }
    },
    getStdout() { return stdoutData; },
    getStderr() { return stderrData; }
  };
}

test('run list command prints available skills', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'list'], io);
  assert.equal(code, 0);
  assert.match(io.getStdout(), /Available Linmas skills:/);
  assert.match(io.getStdout(), /security-operations-lead/);
});

test('run unknown command prints error and returns 1', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'invalid-command'], io);
  assert.equal(code, 1);
  assert.match(io.getStderr(), /Unknown command: invalid-command/);
});
