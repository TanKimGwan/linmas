import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The final name is visible only after a complete, flushed and closed document.
// Used only in disposable test launchers; no production lifecycle hooks.
export function pythonPhasePublication(file, phase, requestId, pids = '[]') {
  return [
    'import json as _phase_json, os as _phase_os, tempfile as _phase_tempfile',
    `_phase_fd, _phase_tmp = _phase_tempfile.mkstemp(prefix='.phase-', dir=${JSON.stringify(path.dirname(file))})`,
    "with _phase_os.fdopen(_phase_fd, 'w', encoding='utf-8') as _phase_out:",
    `    _phase_json.dump({'schemaVersion': 1, 'requestId': ${JSON.stringify(requestId)}, 'phase': ${JSON.stringify(phase)}, 'pids': ${pids}}, _phase_out)`,
    '    _phase_out.flush()',
    '    _phase_os.fsync(_phase_out.fileno())',
    `_phase_os.replace(_phase_tmp, ${JSON.stringify(file)})`
  ].join('\n');
}

export function readPhase(file, { phase, requestId, pidCount }) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`phase notification cannot be opened: ${error.code}`);
  }
  try {
    const item = fs.fstatSync(fd);
    assert(item.isFile() && item.size > 0 && item.size <= 4096, 'invalid phase notification file');
    const bytes = Buffer.alloc(4097);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    assert(length === item.size, 'phase notification changed while reading');
    let value;
    try { value = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { throw new Error('malformed phase notification JSON'); }
    assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid phase notification object');
    assert.deepEqual(Object.keys(value).sort(), ['phase', 'pids', 'requestId', 'schemaVersion'], 'invalid phase notification schema');
    assert.equal(value.schemaVersion, 1, 'unsupported phase notification version');
    assert.equal(value.requestId, requestId, 'stale phase notification request');
    assert.equal(value.phase, phase, 'unexpected phase notification');
    assert(Array.isArray(value.pids) && value.pids.length === pidCount
      && value.pids.every(pid => Number.isSafeInteger(pid) && pid > 0)
      && new Set(value.pids).size === value.pids.length, 'invalid phase notification PIDs');
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

export async function waitForPhase(file, child, expected, {
  timeoutMs = 15000, now = Date.now, pause = () => delay(20)
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    assert(child.exitCode === null && child.signalCode === null, 'process exited before phase');
    assert(now() < deadline, 'phase notification timeout');
    const value = readPhase(file, expected);
    if (value !== null) return value;
    await pause();
  }
}
