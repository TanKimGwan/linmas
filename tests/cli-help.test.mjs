import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/linmas.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function captureIo() {
  const io = { out: '', err: '' };
  io.stdout = { write(value) { io.out += value; return true; } };
  io.stderr = { write(value) { io.err += value; return true; } };
  return io;
}

test('T13 C linmas --help and -h print usage to stdout and exit 0 without running a command', async () => {
  for (const flag of ['--help', '-h']) {
    const io = captureIo();
    assert.equal(await run(['node', 'linmas', flag], io, { get hostRegistry() { throw new Error('help must not run a command'); } }), 0, flag);
    assert.equal(io.err, '', flag);
    assert.match(io.out, /^Usage: linmas <command> \[options\]\n/, flag);
    assert.match(io.out, /-h, --help +Print this help and exit\./);
    assert.match(io.out, /-v, --version +Print the installed Linmas version and exit\./);
    assert.doesNotMatch(io.out, /Available Linmas skills/);
  }
});

test('T13 C usage lists every linmas command from the README command reference', async () => {
  const io = captureIo();
  await run(['node', 'linmas', '--help'], io);
  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const commands = [...readme.matchAll(/^\| `linmas ([^`]+)`/gm)].map((match) => match[1]).filter((command) => !command.startsWith('-'));
  assert.ok(commands.length >= 10, 'README command reference found');
  for (const command of commands) assert.ok(io.out.includes(`  ${command}`), command);
});

test('T13 C help is consistent with --version and leaves other usage unchanged', async () => {
  const extra = captureIo();
  assert.equal(await run(['node', 'linmas', '--help', 'list'], extra), 2);
  assert.equal(extra.err, 'Error: --help does not accept other arguments\n');
  const extraShort = captureIo();
  assert.equal(await run(['node', 'linmas', '-h', 'x'], extraShort), 2);
  assert.equal(extraShort.err, 'Error: -h does not accept other arguments\n');

  // Unchanged: no arguments lists skills; --help after a command stays an unknown option.
  const none = captureIo();
  assert.equal(await run(['node', 'linmas'], none), 0);
  assert.match(none.out, /^Available Linmas skills:\n/);
  const afterCommand = captureIo();
  assert.equal(await run(['node', 'linmas', 'install', '--help'], afterCommand), 2);
  assert.match(afterCommand.err, /^Error: Unknown option '--help'/);
  const version = captureIo();
  assert.equal(await run(['node', 'linmas', '-v'], version), 0);
  assert.match(version.out, /^\d+\.\d+\.\d+\n$/);
});
