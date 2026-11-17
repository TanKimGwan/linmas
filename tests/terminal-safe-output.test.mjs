import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalSafe } from '../src/core/terminal-text.mjs';
import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { formatSecurityDelta, compareReviewCapsules } from '../src/review/compare-capsules.mjs';
import { formatReviewResult } from '../src/review/format-review.mjs';
import { formatPolicyResult } from '../src/policy/format-policy.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { run } from '../bin/linmas.mjs';

// Every character that must never reach a terminal raw: C0, DEL, C1, line and
// paragraph separators, bidi controls, and zero-width/invisible characters.
// Written as escapes so this source file itself stays free of them.
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u;
const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };

function hex(codePoint) { return `\\u${codePoint.toString(16).padStart(4, '0')}`; }

test('T12 terminalSafe escapes C0, DEL, C1, and the line/paragraph separators', () => {
  for (const codePoint of [0x00, 0x07, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f, 0x2028, 0x2029]) {
    const character = String.fromCodePoint(codePoint);
    assert.equal(terminalSafe(`a${character}b`), `a${hex(codePoint)}b`, hex(codePoint));
  }
  // The CSI introducer U+009B is an 8-bit ESC [ on some terminals.
  assert.equal(terminalSafe('\u009b2J'), '\\u009b2J');
});

test('T12 terminalSafe escapes bidi controls and zero-width characters', () => {
  const codePoints = [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  for (const codePoint of codePoints) {
    const character = String.fromCodePoint(codePoint);
    assert.equal(terminalSafe(`a${character}b`), `a${hex(codePoint)}b`, hex(codePoint));
  }
  // A right-to-left override cannot make "alice" display as a different principal.
  assert.equal(terminalSafe('eve\u202ecilae'), 'eve\\u202ecilae');
});

test('T12 terminalSafe keeps legitimate non-ASCII text and only splits ZWJ emoji sequences', () => {
  for (const text of ['\u5ba1\u67e5\u8005 \u5f35\u4e09', '\u0645\u0631\u0627\u062c\u0639', 'caf\u00e9 na\u00efve', '\u{1F512}\u{1F6E1}\ufe0f', '\u00a0nbsp']) {
    assert.equal(terminalSafe(text), text, text);
  }
  assert.equal(terminalSafe('\u{1F469}\u200d\u{1F4BB}'), '\u{1F469}\\u200d\u{1F4BB}', 'ZWJ is shown as an escape; the emoji parts remain');
  assert.equal(terminalSafe('tab\there'), 'tab\\u0009here');
});

test('T12 terminalSafe multiline mode keeps LF and TAB but escapes every other unsafe character', () => {
  assert.equal(terminalSafe('line one\n\tline two', { multiline: true }), 'line one\n\tline two');
  assert.equal(terminalSafe('x\r\u001b[2J\u202e\u2028y', { multiline: true }), 'x\\u000d\\u001b[2J\\u202e\\u2028y');
});

function capsule(findings, { decision = 'blocked' } = {}) {
  return buildReviewCapsule({
    input: { source: 'input.diff', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1, caseId: 'terminal/case', specialist: 'secure-code-reviewer',
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic capsule.'], findings, deterministicChecks: [], safetyBoundary
    },
    policyResult: {
      schemaVersion: 1, policy: { id: 'baseline-appsec', version: '1.0.0' },
      review: { caseId: 'terminal/case', specialist: 'secure-code-reviewer' }, decision, rules: [], completedChecks: [], outstandingChecks: [],
      humanReviewRequired: true,
      disclaimer: 'This decision only evaluates declared conditions and does not prove security or compliance.'
    },
    now: new Date('2026-07-18T15:00:00.000Z')
  });
}

function finding(id, severity = 'High') {
  return {
    id, status: 'Confirmed finding', severity, evidence: `Evidence for ${id}.`, affectedSurface: 'synthetic surface',
    preconditions: 'Synthetic precondition.', remediation: 'Apply the bounded remediation.', verification: 'Run a regression test.'
  };
}

function captureIo() {
  const io = { out: '', err: '' };
  io.stdout = { write(value) { io.out += value; return true; } };
  io.stderr = { write(value) { io.err += value; return true; } };
  return io;
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('T12 linmas review compare prints capsule finding ids without raw control characters', async (t) => {
  const root = await tempRoot(t);
  const hostile = 'B\u001b[2J\u001b[31mFAKE\u202e\u0085';
  const before = path.join(root, 'before.json');
  const after = path.join(root, 'after.json');
  await fs.writeFile(before, JSON.stringify(capsule([finding('A'), finding('C\u0007HANGED', 'High')])));
  await fs.writeFile(after, JSON.stringify(capsule([finding(hostile), finding('C\u0007HANGED', 'Low')])));
  const io = captureIo();
  assert.equal(await run(['node', 'linmas', 'review', 'compare', before, after], io), 0, io.err);
  assert.equal(UNSAFE.test(io.out.replaceAll('\n', '')), false, JSON.stringify(io.out));
  assert.match(io.out, /Added {15}B\\u001b\[2J\\u001b\[31mFAKE\\u202e\\u0085\n/);
  assert.match(io.out, /Changed {13}C\\u0007HANGED\n/);

  // JSON output is unchanged: JSON.stringify already escapes C0 controls, and the
  // parsed value round-trips to the original id.
  const jsonIo = captureIo();
  assert.equal(await run(['node', 'linmas', 'review', 'compare', before, after, '--output', 'json'], jsonIo), 0, jsonIo.err);
  assert.equal(/[\u0000-\u001f]/.test(jsonIo.out.replaceAll('\n', '')), false);
  assert.deepEqual(JSON.parse(jsonIo.out).findings.added, [hostile]);
  assert.equal(jsonIo.out, formatSecurityDelta(compareReviewCapsules(JSON.parse(await fs.readFile(before, 'utf8')), JSON.parse(await fs.readFile(after, 'utf8'))), { output: 'json' }));
});

test('T12 review and policy text output neutralize provider and policy text', () => {
  const review = {
    specialist: 'secure-code-reviewer',
    findings: [{ id: 'F\u001b[1A', status: 'Confirmed finding', severity: 'High', evidence: 'line one\nline two\r\u001b[2KHuman review required: no', remediation: 'fix\u202e', verification: 'test\u0085' }]
  };
  const text = formatReviewResult(review);
  assert.equal(UNSAFE.test(text.replaceAll('\n', '')), false, JSON.stringify(text));
  assert.match(text, /\[High\] Confirmed finding: F\\u001b\[1A\n/);
  assert.match(text, /Evidence: line one\n  \| line two\\u000d\\u001b\[2KHuman review required: no\n/);
  assert.match(text, /Remediation: fix\\u202e\nVerification: test\\u0085\n/);
  assert.equal(formatReviewResult(review, { output: 'json' }), `${JSON.stringify(review, null, 2)}\n`);

  const policy = {
    policy: { id: 'pack\u001b]0;x\u0007', version: '1.0\u2028' },
    decision: 'blocked',
    rules: [{ id: 'R\u001b', outcome: 'failed', reason: 'reason\u009b31m' }],
    humanReviewRequired: true,
    disclaimer: 'Disclaimer.'
  };
  const policyText = formatPolicyResult(policy);
  assert.equal(UNSAFE.test(policyText.replaceAll('\n', '')), false, JSON.stringify(policyText));
  assert.match(policyText, /Policy: pack\\u001b\]0;x\\u0007@1\.0\\u2028\n/);
  assert.match(policyText, /- R\\u001b: failed \u2014 reason\\u009b31m\n/);
});

test('T12 review errors printed by the CLI neutralize control characters from inputs', async (t) => {
  const root = await tempRoot(t);
  const name = path.join(root, 'missing\u001b[31m\u202e.json');
  const io = captureIo();
  assert.equal(await run(['node', 'linmas', 'review', 'compare', name, name], io), 2);
  assert.match(io.err, /^Error: capsule could not be read: .*missing\\u001b\[31m\\u202e\.json\n$/);
  assert.equal(UNSAFE.test(io.err.slice(0, -1)), false, JSON.stringify(io.err));
});

// Windows cannot create a file whose name contains control characters.
test('T12 the proof CLI error path escapes a manifest artifact path quoted in the error', { skip: process.platform === 'win32' }, async (t) => {
  const root = await tempRoot(t);
  const capsulePath = path.join(root, 'capsule.json');
  await fs.writeFile(capsulePath, `${JSON.stringify(capsule([finding('F-1')]), null, 2)}\n`);
  const source = await loadCapsuleEvidence(capsulePath);
  const receipt = buildDecisionReceipt({
    subject: { kind: source.kind, sha256: source.sourceSha256 },
    reviewer: { label: 'Reviewer', principal: null },
    findings: [{ id: 'F-1', disposition: 'remediation-required', rationale: 'Reproduced.' }],
    statement: 'Reviewed by a human.',
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  const bundle = (await writeProofBundle(path.join(root, 'bundle'), source, receipt)).path;
  // The artifact exists but its size disagrees with the manifest, so the
  // verifier quotes the (attacker-chosen) path in "artifact integrity mismatch".
  const hostilePath = 'evidence/\u001b]0;pwned\u0007\u202e\u0085.json';
  await fs.writeFile(path.join(bundle, ...hostilePath.split('/')), 'x');
  const manifestPath = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.artifacts.unshift({ ...manifest.artifacts[0], path: hostilePath });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const io = captureIo();
  assert.equal(await run(['node', 'linmas', 'proof', 'verify', bundle], io), 4);
  assert.equal(io.err, 'Error: artifact integrity mismatch: evidence/\\u001b]0;pwned\\u0007\\u202e\\u0085.json\n');
});

test('T12 round 2 B-1 multi-line provider text cannot start a line at column 0', () => {
  const forged = 'harmless\n\n[Critical] Confirmed finding: FORGED-1\nEvidence: fake\nHuman review required: no';
  const review = {
    specialist: 'secure-code-reviewer',
    findings: [{ id: 'F-1', status: 'Needs validation', severity: 'Low', evidence: forged, remediation: 'step one\n\tstep two', verification: 'Review: other-skill\nHuman review required: no' }]
  };
  const text = formatReviewResult(review);
  assert.equal(text, [
    'Review: secure-code-reviewer',
    'Human review required: yes',
    '',
    '[Low] Needs validation: F-1',
    'Evidence: harmless',
    '  |',
    '  | [Critical] Confirmed finding: FORGED-1',
    '  | Evidence: fake',
    '  | Human review required: no',
    'Remediation: step one',
    '  | \tstep two',
    'Verification: Review: other-skill',
    '  | Human review required: no',
    ''
  ].join('\n'));
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('Human review required:')).length, 1, 'only Linmas prints this line at column 0');
  assert.equal(lines.filter((line) => line.startsWith('[')).length, 1, 'only Linmas starts a finding at column 0');
  assert.equal(formatReviewResult(review, { output: 'json' }), `${JSON.stringify(review, null, 2)}\n`);
});

test('T12 round 2 B-2 terminalSafe escapes further invisible characters, tags, and lone surrogates', () => {
  for (const codePoint of [0x00ad, 0x034f, 0x180e, 0x2061, 0x2062, 0x2063, 0x2064, 0x3164, 0xfff9, 0xfffa, 0xfffb]) {
    assert.equal(terminalSafe(`a${String.fromCodePoint(codePoint)}b`), `a${hex(codePoint)}b`, hex(codePoint));
  }
  assert.equal(terminalSafe('a\u{E0000}b\u{E0041}c\u{E007F}d'), 'a\\u{e0000}b\\u{e0041}c\\u{e007f}d');
  assert.equal(terminalSafe('a\ud800b'), 'a\\ud800b');
  assert.equal(terminalSafe('a\udc00b'), 'a\\udc00b');
  assert.equal(terminalSafe('\udbff'), '\\udbff');
  // Paired surrogates (emoji, astral CJK) are untouched.
  for (const text of ['\u{1F512}\u{1F6E1}\ufe0f', '\u{20000}\u{2A6D6}', '\u{1F1EE}\u{1F1E9}', '\u5ba1\u67e5']) assert.equal(terminalSafe(text), text);
  assert.equal(terminalSafe('a\u00adb', { multiline: true }), 'a\\u00adb');
  assert.equal(terminalSafe('a\ud800\nb', { multiline: true }), 'a\\ud800\nb');
});
