import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { run, createProcessIO } from '../bin/linmas.mjs';
import { buildReviewCapsule } from '../src/review/build-capsule.mjs';

// These tests drive run() through the real createProcessIO with in-memory streams
// that stand in for a terminal, so prompts, readline buffering, and EOF behave as
// they do for a real user.

const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };
const providerResponse = JSON.stringify({ schemaVersion: 1, scopeAndAssumptions: ['fixture'], findings: [], deterministicChecks: [], safetyBoundary });
const REVIEW_PROMPT = /Type yes to transmit: $/;

function fakeProcess({ tty = true, script = [] } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  let stdout = '';
  let stderr = '';
  let consumed = 0;
  const pending = [...script];
  const respond = () => {
    const step = pending[0];
    if (!step || !step.prompt.test(stdout.slice(consumed))) return;
    pending.shift();
    consumed = stdout.length;
    // Answer asynchronously, as a person typing after the prompt appears.
    setImmediate(() => { if (step.answer === null) stdin.end(); else stdin.write(`${step.answer}\n`); });
  };
  const proc = {
    stdin,
    stdout: { isTTY: tty, write(value) { stdout += value; respond(); return true; } },
    stderr: { isTTY: tty, write(value) { stderr += value; return true; } }
  };
  return {
    proc,
    stdin,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get unansweredPrompts() { return pending.length; }
  };
}

function fakeProviderRegistry() {
  const calls = [];
  const registry = new Map([['fake', {
    create: ({ model }) => ({ run: async (request) => { calls.push(request); return { provider: 'fake', model: model ?? 'fake-model', rawResponse: providerResponse }; } })
  }]]);
  return { registry, calls };
}

async function runCli(args, fake, dependencies = {}) {
  const io = createProcessIO(fake.proc);
  try {
    return await run(['node', 'linmas.mjs', ...args], io, dependencies);
  } finally {
    io.close();
  }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-cli-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function reviewArgs(dir, extra = []) {
  const input = path.join(dir, 'input.txt');
  fs.writeFileSync(input, 'safe review input');
  return ['review', '--skill', 'secure-code-reviewer', '--input', input, '--provider', 'fake', '--output', 'json', ...extra];
}

test('interactive review transmits after the person answers yes at the prompt', async (t) => {
  const fake = fakeProcess({ script: [{ prompt: REVIEW_PROMPT, answer: 'yes' }] });
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(reviewArgs(tempDir(t)), fake, { providerRegistry: registry });
  assert.equal(code, 0, fake.stderr);
  assert.equal(calls.length, 1);
  assert.match(fake.stdout, /data leaves this machine: yes\nType yes to transmit: /);
});

test('interactive review does not transmit when the person answers no', async (t) => {
  const fake = fakeProcess({ script: [{ prompt: REVIEW_PROMPT, answer: 'no' }] });
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(reviewArgs(tempDir(t)), fake, { providerRegistry: registry });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(fake.stderr, /outbound transmission not confirmed/);
});

test('interactive review fails closed on EOF at the prompt', async (t) => {
  const fake = fakeProcess({ script: [{ prompt: REVIEW_PROMPT, answer: null }] });
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(reviewArgs(tempDir(t)), fake, { providerRegistry: registry });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(fake.stderr, /outbound transmission not confirmed/);
});

test('non-interactive review without --yes is rejected before prompting', async (t) => {
  const fake = fakeProcess({ tty: false });
  fake.stdin.end('yes\n');
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(reviewArgs(tempDir(t)), fake, { providerRegistry: registry });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(fake.stderr, /non-interactive execution requires --yes/);
  assert.doesNotMatch(fake.stdout, /Type yes to transmit/);
});

test('--stdin without --yes is rejected even on a terminal', async () => {
  const fake = fakeProcess();
  fake.stdin.end('yes\nreview this stdin input\n');
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(['review', '--skill', 'secure-code-reviewer', '--stdin', '--provider', 'fake'], fake, { providerRegistry: registry });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(fake.stderr, /--stdin requires --yes/);
});

test('piped --stdin with --yes still transmits the full input', async () => {
  const fake = fakeProcess({ tty: false });
  fake.stdin.end('first line of piped input\nsecond line\n');
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(['review', '--skill', 'secure-code-reviewer', '--stdin', '--provider', 'fake', '--yes', '--output', 'json'], fake, { providerRegistry: registry });
  assert.equal(code, 0, fake.stderr);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].user).input, 'first line of piped input\nsecond line\n');
});

test('a yes typed before the outbound summary is not accepted as consent', async (t) => {
  const fake = fakeProcess({ script: [{ prompt: REVIEW_PROMPT, answer: null }] });
  fake.stdin.write('yes\n');
  const { registry, calls } = fakeProviderRegistry();
  const code = await runCli(reviewArgs(tempDir(t)), fake, { providerRegistry: registry });
  assert.equal(code, 2, 'typeahead must be discarded, leaving EOF as the answer');
  assert.equal(calls.length, 0);
  assert.match(fake.stderr, /outbound transmission not confirmed/);
});

function writeCapsule(dir) {
  const capsulePath = path.join(dir, 'capsule.json');
  const capsule = buildReviewCapsule({
    input: { source: 'input.diff', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1,
      caseId: 'cli/proof',
      specialist: 'secure-code-reviewer',
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic CLI fixture.'],
      findings: [{
        id: 'F-1', status: 'Confirmed finding', severity: 'High', evidence: 'Synthetic evidence.',
        affectedSurface: 'Synthetic surface.', preconditions: 'Synthetic precondition.',
        remediation: 'Apply a synthetic fix.', verification: 'Run the regression test.'
      }],
      deterministicChecks: [],
      safetyBoundary
    },
    policyResult: null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  fs.writeFileSync(capsulePath, `${JSON.stringify(capsule, null, 2)}\n`);
  return capsulePath;
}

test('interactive proof create runs through every wizard prompt', async (t) => {
  const dir = tempDir(t);
  const bundle = path.join(dir, 'bundle');
  const fake = fakeProcess({
    script: [
      { prompt: /Reviewer label: $/, answer: 'Synthetic reviewer' },
      { prompt: /Disposition: $/, answer: '1' },
      { prompt: /Rationale: $/, answer: 'Fix before release.' },
      { prompt: /Human summary: $/, answer: 'One finding needs remediation.' },
      { prompt: /Create immutable proof bundle\? \[y\/N\]: $/, answer: 'y' }
    ]
  });
  const code = await runCli(['proof', 'create', writeCapsule(dir), '--bundle', bundle], fake);
  assert.equal(code, 0, fake.stderr);
  assert.equal(fake.unansweredPrompts, 0);
  assert.match(fake.stdout, /Proof bundle created: /);
  assert.ok(fs.statSync(bundle).isDirectory());
});

test('a proof confirmation typed ahead of the final prompt is discarded', async (t) => {
  const dir = tempDir(t);
  const bundle = path.join(dir, 'bundle');
  const fake = fakeProcess({
    script: [
      { prompt: /Reviewer label: $/, answer: 'Synthetic reviewer' },
      { prompt: /Disposition: $/, answer: '1' },
      { prompt: /Rationale: $/, answer: 'Fix before release.' },
      // The summary answer carries a premature "y" for the confirmation prompt.
      { prompt: /Human summary: $/, answer: 'One finding needs remediation.\ny' },
      { prompt: /Create immutable proof bundle\? \[y\/N\]: $/, answer: null }
    ]
  });
  const code = await runCli(['proof', 'create', writeCapsule(dir), '--bundle', bundle], fake);
  assert.equal(code, 2);
  assert.match(fake.stderr, /input ended unexpectedly/);
  assert.equal(fs.existsSync(bundle), false);
});

test('non-interactive proof create is rejected before any prompt', async (t) => {
  const dir = tempDir(t);
  const fake = fakeProcess({ tty: false });
  fake.stdin.end('Synthetic reviewer\n1\nrationale\nsummary\ny\n');
  const code = await runCli(['proof', 'create', writeCapsule(dir), '--bundle', path.join(dir, 'bundle')], fake);
  assert.equal(code, 2);
  assert.match(fake.stderr, /requires an interactive TTY/);
  assert.equal(fake.stdout, '');
});

test('proof create cannot read its source from stdin', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = tempDir(t);
  const fake = fakeProcess();
  const code = await runCli(['proof', 'create', '/dev/stdin', '--bundle', path.join(dir, 'bundle')], fake);
  assert.equal(code, 2);
  assert.match(fake.stderr, /regular non-symlink|could not be/);
});
