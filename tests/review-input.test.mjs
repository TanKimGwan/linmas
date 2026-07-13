import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadReviewInput } from '../src/review/load-input.mjs';

test('requires exactly one explicit input source', async () => {
  await assert.rejects(() => loadReviewInput({}), /exactly one of --input or --stdin/);
  await assert.rejects(() => loadReviewInput({ inputPath: 'a', useStdin: true }), /exactly one/);
});

test('loads text file and rejects NUL or oversized content', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-review-'));
  fs.writeFileSync(path.join(cwd, 'ok.diff'), '+safe change');
  assert.equal((await loadReviewInput({ inputPath: 'ok.diff', cwd })).content, '+safe change');
  fs.writeFileSync(path.join(cwd, 'binary'), Buffer.from([0, 1]));
  await assert.rejects(() => loadReviewInput({ inputPath: 'binary', cwd }), /binary input/);
  fs.writeFileSync(path.join(cwd, 'large'), '123456789');
  await assert.rejects(() => loadReviewInput({ inputPath: 'large', cwd, maxBytes: 8 }), /exceeds 8 bytes/);
});

test('bounds stdin before returning it', async () => {
  const stdin = Readable.from(['x'.repeat(9)]);
  await assert.rejects(() => loadReviewInput({ useStdin: true, stdin, maxBytes: 8 }), /exceeds 8 bytes/);
});
