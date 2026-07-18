import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { buildReviewCapsule, fingerprintReviewInput } from '../src/review/build-capsule.mjs';
import { validateReviewCapsule } from '../src/review/validate-capsule.mjs';
import { preflightCapsuleDestination, writeReviewCapsule } from '../src/review/write-capsule.mjs';
import { runReview } from '../src/review/run-review.mjs';

const safetyBoundary = {
  satisfied: true,
  humanReviewRequired: true,
  statement: 'Human review remains required.'
};

const review = {
  schemaVersion: 1,
  caseId: 'review/local',
  specialist: 'secure-code-reviewer',
  modelMetadata: { provider: 'codex', model: 'gpt-5.6-sol', usage: null, requestId: 'private-request-id' },
  scopeAndAssumptions: ['Only the supplied input was reviewed.'],
  findings: [],
  deterministicChecks: [{ id: 'security regression test', completed: true }],
  safetyBoundary
};

function build(overrides = {}) {
  return buildReviewCapsule({
    input: { source: 'fixture.diff', bytes: 3, sha256: fingerprintReviewInput(Buffer.from('abc')) },
    execution: { mode: 'live', provider: 'codex', authMode: 'chatgpt', model: 'gpt-5.6-sol', modelVerified: true },
    review,
    policyResult: null,
    now: new Date('2026-07-18T15:00:00.000Z'),
    ...overrides
  });
}

test('fingerprints the exact reviewed bytes with stable SHA-256', () => {
  assert.equal(fingerprintReviewInput(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(fingerprintReviewInput(Buffer.from('abc\n')), fingerprintReviewInput(Buffer.from('abc')));
});

test('distinguishes live and offline capsules without inventing policy decisions', () => {
  const live = build();
  assert.equal(live.execution.mode, 'live');
  assert.equal(live.execution.authMode, 'chatgpt');
  assert.deepEqual(live.policy, { status: 'not-evaluated', result: null });

  const offline = build({
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture-result', modelVerified: false }
  });
  assert.equal(offline.execution.mode, 'offline-fixture');
  assert.equal(offline.execution.authMode, 'unavailable');
});

test('capsule whitelists execution metadata and removes private request identifiers', () => {
  const capsule = build({
    execution: {
      mode: 'live', provider: 'codex', authMode: 'chatgpt', model: 'gpt-5.6-sol', modelVerified: true,
      email: 'private@example.test', stderr: 'token=secret', sessionId: 'private-session'
    }
  });
  const serialized = JSON.stringify(capsule);
  assert.doesNotMatch(serialized, /private@example|token=secret|private-session|private-request-id/);
  assert.equal(capsule.review.modelMetadata.requestId, null);
});

test('contradictory safety boundary prevents capsule validation', () => {
  const capsule = build();
  capsule.review.safetyBoundary.statement = 'Automatically approve without human review.';
  assert.throws(() => validateReviewCapsule(capsule), /safety|human review/i);
});

test('preflight rejects existing destinations and symlinked parents', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linmas-capsule-'));
  try {
    const existing = path.join(root, 'existing.json');
    await fsp.writeFile(existing, 'keep');
    await assert.rejects(preflightCapsuleDestination(existing), /already exists/);

    const real = path.join(root, 'real');
    const linked = path.join(root, 'linked');
    await fsp.mkdir(real);
    await fsp.symlink(real, linked, 'dir');
    await assert.rejects(preflightCapsuleDestination(path.join(linked, 'capsule.json')), /symlink/);
    assert.equal(await fsp.readFile(existing, 'utf8'), 'keep');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('atomic write leaves no partial destination and preserves the primary failure', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linmas-capsule-'));
  try {
    const destination = path.join(root, 'capsule.json');
    const target = await preflightCapsuleDestination(destination);
    const primary = Object.assign(new Error('synthetic link failure'), { code: 'EIO' });
    const fsApi = { ...fsp, async link() { throw primary; } };
    await assert.rejects(
      writeReviewCapsule(target, build(), { fsApi, randomId: () => 'fixed' }),
      (error) => error.cause === primary && /could not be written/.test(error.message)
    );
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(await fsp.readdir(root), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('runReview writes a validated capsule without changing existing JSON output', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linmas-capsule-run-'));
  try {
    const destination = path.join(root, 'capsule.json');
    const providerResult = JSON.stringify({
      schemaVersion: 1,
      scopeAndAssumptions: ['fixture'],
      findings: [],
      deterministicChecks: ['security regression test'],
      safetyBoundary
    });
    const providerRegistry = new Map([['fake', {
      create: () => ({ id: 'fake', model: 'fixture-model', run: async () => ({ provider: 'fake', model: 'fixture-model', rawResponse: providerResult }) })
    }]]);
    const args = {
      inputPath: null, useStdin: true, skillName: 'secure-code-reviewer', provider: 'fake', model: 'fixture-model',
      output: 'json', assumeYes: true, policyId: null, policyFile: null
    };
    const makeIo = () => ({ stdin: Readable.from(['abc']), stdout: { write() {} }, isTTY: false });
    const withoutCapsule = await runReview(args, { cwd: root, io: makeIo(), providerRegistry });
    const withCapsule = await runReview({ ...args, capsulePath: destination }, { cwd: root, io: makeIo(), providerRegistry });

    assert.equal(withCapsule.output, withoutCapsule.output);
    const capsule = JSON.parse(await fsp.readFile(destination, 'utf8'));
    assert.equal(validateReviewCapsule(capsule).kind, 'linmas-review-capsule');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('live capsule records actual normalized provider metadata and provider failure leaves no artifact', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'linmas-capsule-run-'));
  try {
    const destination = path.join(root, 'capsule.json');
    const providerRegistry = new Map([['fake', {
      create: () => ({
        id: 'fake', model: 'requested-model',
        run: async () => ({
          provider: 'fake', model: 'actual-model',
          rawResponse: JSON.stringify({
            schemaVersion: 1,
            scopeAndAssumptions: ['fixture'],
            findings: [],
            deterministicChecks: [],
            safetyBoundary
          })
        })
      })
    }]]);
    const args = {
      inputPath: null, useStdin: true, skillName: 'secure-code-reviewer', provider: 'fake', model: 'requested-model',
      output: 'json', assumeYes: true, policyId: null, policyFile: null, capsulePath: destination
    };
    await runReview(args, {
      cwd: root,
      io: { stdin: Readable.from(['abc']), stdout: { write() {} }, isTTY: false },
      providerRegistry
    });
    const capsule = JSON.parse(await fsp.readFile(destination, 'utf8'));
    assert.equal(capsule.execution.provider, 'fake');
    assert.equal(capsule.execution.model, 'actual-model');
    assert.equal(capsule.execution.modelVerified, false);

    await fsp.rm(destination);
    providerRegistry.get('fake').create = () => ({
      id: 'fake', model: 'requested-model',
      run: async () => ({ provider: 'fake', model: 'actual-model', rawResponse: '{malformed' })
    });
    await assert.rejects(
      runReview(args, {
        cwd: root,
        io: { stdin: Readable.from(['abc']), stdout: { write() {} }, isTTY: false },
        providerRegistry
      }),
      /contract validation/
    );
    assert.equal(fs.existsSync(destination), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
