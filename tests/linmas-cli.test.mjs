import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/linmas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'linmas.mjs');

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
    getStdout() {
      return stdoutData;
    },
    getStderr() {
      return stderrData;
    }
  };
}

test('run list command prints available skills', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'list'], io);

  assert.equal(code, 0);
  assert.match(io.getStdout(), /Available Linmas skills:/);
  assert.match(io.getStdout(), /security-operations-lead/);
  assert.equal(io.getStderr(), '');
});

test('run unknown command prints error and returns 1', async () => {
  const io = createMockIO();
  const code = await run(['node', 'bin/linmas.mjs', 'invalid-command'], io);

  assert.equal(code, 1);
  assert.equal(io.getStdout(), '');
  assert.match(io.getStderr(), /Unknown command: invalid-command/);
});

test('symlinked top-level entrypoint prints list output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-'));
  const symlinkPath = path.join(tempDir, 'linmas');
  fs.symlinkSync(cliPath, symlinkPath);

  const output = execFileSync(process.execPath, [symlinkPath, 'list'], {
    cwd: rootDir,
    encoding: 'utf8'
  });

  assert.match(output, /Available Linmas skills:/);
  assert.match(output, /security-operations-lead/);
});

test('symlinked top-level entrypoint reports unknown commands', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-'));
  const symlinkPath = path.join(tempDir, 'linmas');
  fs.symlinkSync(cliPath, symlinkPath);

  assert.throws(
    () => execFileSync(process.execPath, [symlinkPath, 'bad-command'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    /Unknown command: bad-command/
  );
});
