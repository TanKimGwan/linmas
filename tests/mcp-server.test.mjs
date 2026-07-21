import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { loadCapsuleEvidence } from '../src/proof/load-evidence.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import {
  MAX_OUTPUT_BYTES,
  MAX_MCP_LINE_BYTES,
  SERVER_VERSION,
  TOOL_TIMEOUTS,
  createLinmasDispatcher,
  createStdioServer,
  listTools,
  readBoundedJsonLines,
  validatePortableRelativePath
} from '../mcp/server.mjs';

const safetyBoundary = { satisfied: true, humanReviewRequired: true, statement: 'Human review remains required.' };

function capsule({ findings = [], source = 'input.diff', specialist = 'secure-code-reviewer', decision = null } = {}) {
  return buildReviewCapsule({
    input: { source, bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    execution: { mode: 'offline-fixture', provider: 'fixture', authMode: 'unavailable', model: 'fixture', modelVerified: false },
    review: {
      schemaVersion: 1,
      caseId: 'mcp/test',
      specialist,
      modelMetadata: { provider: 'fixture', model: 'fixture', usage: null, requestId: null },
      scopeAndAssumptions: ['Synthetic MCP fixture.'],
      findings,
      deterministicChecks: [],
      safetyBoundary
    },
    policyResult: decision ? {
      schemaVersion: 1,
      policy: { id: 'baseline-appsec', version: '1.0.0' },
      review: { caseId: 'mcp/test', specialist },
      decision,
      rules: [],
      completedChecks: [],
      outstandingChecks: [],
      humanReviewRequired: true,
      disclaimer: 'This decision only evaluates declared conditions and does not prove security or compliance.'
    } : null,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linmas-mcp-'));
  await fs.writeFile(path.join(root, 'before.json'), `${JSON.stringify(capsule({ findings: [] }), null, 2)}\n`);
  await fs.writeFile(path.join(root, 'after.json'), `${JSON.stringify(capsule({ findings: [], source: 'after.diff' }), null, 2)}\n`);
  return root;
}

test('MCP discovery exposes seven bounded tools with strict schemas', () => {
  const tools = listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'linmas_review_decide',
    'linmas_review_prepare',
    'linmas_review_compare',
    'linmas_policy_evaluate',
    'linmas_proof_verify',
    'linmas_proof_create',
    'linmas_review_execute'
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.timeout_ms);
  }
});

test('offline prepare is read-only and returns prepared plus human-review state', async () => {
  const root = await setup();
  try {
    const before = await fs.readdir(root);
    const dispatch = createLinmasDispatcher();
    const result = await dispatch('linmas_review_prepare', {
      workspace_root: root,
      input_text: 'SELECT * FROM users WHERE id = $id',
      skill_name: 'linmas-secure-code-reviewer'
    });
    assert.equal(result.status, 'prepared');
    assert.equal(result.dataLeavesMachine, false);
    assert.equal(result.humanReviewRequired, true);
    assert.equal(result.request.specialist, 'secure-code-reviewer');
    assert.deepEqual(await fs.readdir(root), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('offline prepare accepts documented legacy specialist aliases and normalizes them', async () => {
  const root = await setup();
  try {
    const result = await createLinmasDispatcher()('linmas_review_prepare', {
      workspace_root: root,
      input_text: 'SELECT * FROM users WHERE id = $id',
      skill_name: 'secure-code-reviewer'
    });
    assert.equal(result.request.specialist, 'secure-code-reviewer');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider preflight fails before input execution and exposes safe configuration details', async () => {
  const root = await setup();
  try {
    const server = createStdioServer({ dispatcher: createLinmasDispatcher({ env: {} }) });
    const response = await server.handle({
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'linmas_review_execute', arguments: {
        workspace_root: root,
        input_text: 'synthetic fixture',
        skill_name: 'secure-code-reviewer',
        provider: 'claude',
        confirm_transmission: true
      } }
    });
    const envelope = response.result.structuredContent;
    assert.equal(envelope.error.code, 'PROVIDER_CONFIGURATION_MISSING');
    assert.equal(envelope.error.stage, 'provider-preflight');
    assert.deepEqual(envelope.error.missingRequirements, ['ANTHROPIC_API_KEY', 'LINMAS_EVAL_MODEL']);
    assert.equal(envelope.error.transmissionState, 'not-attempted');
    assert.equal(envelope.error.transmissionAttempted, false);
    assert.match(response.result.content[0].text, /PROVIDER_CONFIGURATION_MISSING/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('all offline tool paths validate strict input and workspace boundaries', async () => {
  const root = await setup();
  try {
    const dispatch = createLinmasDispatcher();
    await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: root, input_text: 'x', extra: true }), /unknown input field/);
    await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: root, input_path: '../outside' }), /relative path without traversal|invalid/);
    await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: root, input_text: 'x'.repeat(64 * 1024 + 1) }), /bounded string|input/);
    await assert.rejects(dispatch('linmas_review_compare', { workspace_root: root, before_capsule_path: 'before.json', after_capsule_path: '../after.json' }), /relative path without traversal/);
    await assert.rejects(dispatch('linmas_policy_evaluate', { workspace_root: root, capsule_path: 'before.json', policy_id: 'baseline-appsec', policy_path: 'custom.json' }), /exactly one/);
    await assert.rejects(dispatch('linmas_proof_verify', { workspace_root: root, bundle_path: 'missing' }), /does not exist/);
    const outside = path.join(root, '..', `linmas-mcp-outside-${process.pid}`);
    await fs.writeFile(outside, 'outside');
    try {
      await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: root, input_path: 'link/secret' }), /does not exist|symlink|invalid/);
    } finally {
      await fs.rm(outside, { force: true });
    }
    await fs.symlink(path.dirname(outside), path.join(root, 'link'), 'dir');
    try {
      await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: root, input_path: 'link/secret' }), /symlink/);
    } finally {
      await fs.rm(path.join(root, 'link'), { force: true });
    }
    const linkedRoot = `${root}-link`;
    await fs.symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: linkedRoot, input_text: 'x' }), /symlink/);
    } finally {
      await fs.rm(linkedRoot, { force: true });
    }
    await assert.rejects(dispatch('linmas_review_prepare', { workspace_root: root, input_text: 'x', timeout_ms: TOOL_TIMEOUTS.read.maxMs + 1 }), /bounded tool limit/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('relative path validation preserves Linux rejection and supports Windows separators safely', () => {
  assert.doesNotThrow(() => validatePortableRelativePath('nested\\capsule.json', 'capsule_path', { platform: 'win32', pathImpl: path.win32 }));
  assert.doesNotThrow(() => validatePortableRelativePath('nested/capsule.json', 'capsule_path', { platform: 'win32', pathImpl: path.win32 }));
  assert.throws(() => validatePortableRelativePath('nested\\..\\outside.json', 'capsule_path', { platform: 'win32', pathImpl: path.win32 }), /traversal/);
  assert.throws(() => validatePortableRelativePath('nested\\capsule.json', 'capsule_path', { platform: 'linux', pathImpl: path.posix }), /relative path/);
});

test('MCP arguments and real dispatcher output remain bounded', async () => {
  const root = await setup();
  try {
    const dispatch = createLinmasDispatcher();
    await assert.rejects(
      dispatch('linmas_proof_create', {
        workspace_root: root,
        source_path: 'before.json',
        bundle_path: 'oversized',
        reviewer: { label: 'Synthetic reviewer', principal: null },
        findings: Array.from({ length: 256 }, (_, index) => ({
          id: `F-${index}`,
          disposition: 'needs-more-evidence',
          rationale: 'x'.repeat(16 * 1024)
        })),
        statement: 'bounded fixture',
        confirm_write: false
      }),
      /MCP frame limit|bounded/i
    );

    const oversizedProvider = new Map([['codex', {
      detectConfiguration: () => ({ status: 'configured', defaultModel: 'fixture-model' }),
      create: () => ({ run: async () => ({
        provider: 'codex',
        model: 'fixture-model',
        usage: null,
        requestId: null,
        rawResponse: JSON.stringify({
          schemaVersion: 1,
          scopeAndAssumptions: Array.from({ length: 20 }, () => 'x'.repeat(16 * 1024)),
          findings: [],
          deterministicChecks: [],
          safetyBoundary
        })
      }) })
    }]]);
    await assert.rejects(
      createLinmasDispatcher({ providerRegistry: oversizedProvider })('linmas_review_execute', {
        workspace_root: root,
        input_text: 'fixture',
        skill_name: 'linmas-secure-code-reviewer',
        provider: 'codex',
        confirm_transmission: true
      }),
      /output exceeds/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider timeout is bounded and does not expose provider diagnostics', async () => {
  const root = await setup();
  const providerRegistry = new Map([['codex', {
    detectConfiguration: () => ({ status: 'configured', defaultModel: 'fixture-model' }),
    create: () => ({ run: () => new Promise(() => {}) })
  }]]);
  try {
    await assert.rejects(
      createLinmasDispatcher({ providerRegistry })('linmas_review_execute', {
        workspace_root: root,
        input_text: 'fixture',
        skill_name: 'linmas-secure-code-reviewer',
        provider: 'codex',
        confirm_transmission: true,
        timeout_ms: 100
      }),
      /timed out|cancelled/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('delayed provider cannot create a capsule after timeout has been returned', async () => {
  const root = await setup();
  let resolveProvider;
  const providerRegistry = new Map([['codex', {
    detectConfiguration: () => ({ status: 'configured', defaultModel: 'fixture-model' }),
    create: () => ({ run: () => new Promise((resolve) => { resolveProvider = resolve; }) })
  }]]);
  const capsulePath = path.join(root, 'late-capsule.json');
  try {
    const invocation = createLinmasDispatcher({ providerRegistry })('linmas_review_execute', {
      workspace_root: root,
      input_text: 'fixture',
      skill_name: 'linmas-secure-code-reviewer',
      provider: 'codex',
      confirm_transmission: true,
      capsule_path: 'late-capsule.json',
      timeout_ms: 100
    });
    await assert.rejects(invocation, /timed out|cancelled/);
    resolveProvider({
      provider: 'codex',
      model: 'fixture-model',
      usage: null,
      requestId: null,
      rawResponse: JSON.stringify({ schemaVersion: 1, scopeAndAssumptions: ['fixture'], findings: [], deterministicChecks: [], safetyBoundary })
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(fs.lstat(capsulePath), { code: 'ENOENT' });
  } finally {
    resolveProvider?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded MCP reader enforces bytes before newline and handles fragmented UTF-8, batches, CRLF, and malformed JSON', async () => {
  const messages = [];
  const invalid = [];
  const exactPadding = 'x'.repeat(MAX_MCP_LINE_BYTES - Buffer.byteLength('{"data":""}', 'utf8'));
  const exact = Buffer.from(JSON.stringify({ data: exactPadding }) + '\n', 'utf8');
  assert.equal(exact.byteLength - 1, MAX_MCP_LINE_BYTES);
  const utf8 = Buffer.from(`${JSON.stringify({ text: 'fragmented 安全' })}\n`, 'utf8');
  const batched = Buffer.from('{"id":1}\r\n{"id":2}\n', 'utf8');
  const malformed = Buffer.from('{"broken":}\n', 'utf8');
  await readBoundedJsonLines(Readable.from([
    exact.subarray(0, 7), exact.subarray(7),
    utf8.subarray(0, 9), utf8.subarray(9, 10), utf8.subarray(10),
    batched, malformed
  ]), {
    onMessage: async (message) => { messages.push(message); },
    onInvalid: (error) => { invalid.push(error.code); }
  });
  assert.equal(messages[0].data.length, exactPadding.length);
  assert.deepEqual(messages.slice(1), [{ text: 'fragmented 安全' }, { id: 1 }, { id: 2 }]);
  assert.deepEqual(invalid, ['MALFORMED_JSON']);
});

test('bounded MCP reader rejects oversized unterminated input deterministically and stops the stream', async () => {
  const input = Readable.from([Buffer.alloc(MAX_MCP_LINE_BYTES + 1, 0x78)]);
  await assert.rejects(readBoundedJsonLines(input), /bounded .* limit/);
  assert.equal(input.destroyed, true);
});

test('offline compare, policy evaluate, and proof verify return verified bounded results', async () => {
  const root = await setup();
  try {
    const dispatch = createLinmasDispatcher();
    const compare = await dispatch('linmas_review_compare', { workspace_root: root, before_capsule_path: 'before.json', after_capsule_path: 'after.json' });
    assert.equal(compare.status, 'verified');
    assert.equal(compare.humanReviewRequired, true);
    assert.ok(compare.delta.disclaimer.includes('does not prove remediation'));

    const policy = await dispatch('linmas_policy_evaluate', { workspace_root: root, capsule_path: 'before.json', policy_id: 'baseline-appsec' });
    assert.equal(policy.status, 'verified');
    assert.equal(policy.policy.humanReviewRequired, true);
    assert.match(policy.policy.disclaimer, /does not prove security or compliance/);

    const source = await loadCapsuleEvidence(path.join(root, 'before.json'));
    const receipt = buildDecisionReceipt({
      subject: { kind: source.kind, sha256: source.sourceSha256 },
      reviewer: { label: 'Synthetic reviewer', principal: null },
      findings: [],
      statement: 'No action is recorded.',
      now: new Date('2026-07-19T00:00:00.000Z')
    });
    await writeProofBundle(path.join(root, 'bundle'), source, receipt);
    const verified = await dispatch('linmas_proof_verify', { workspace_root: root, bundle_path: 'bundle' });
    assert.equal(verified.status, 'verified');
    assert.equal(verified.verification.integrity, 'valid');
    assert.equal(verified.verification.receipt.overallDisposition, 'no-findings-reported');
    assert.equal(Object.hasOwn(verified.verification, 'receipt') && Object.hasOwn(verified.verification.receipt, 'rationale'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('proof create requires explicit write confirmation and verifies its own result', async () => {
  const root = await setup();
  try {
    const dispatch = createLinmasDispatcher();
    const args = {
      workspace_root: root,
      source_path: 'before.json',
      bundle_path: 'new-bundle',
      reviewer: { label: 'Synthetic reviewer', principal: null },
      findings: [],
      statement: 'No action is recorded.',
      confirm_write: false
    };
    const prepared = await dispatch('linmas_proof_create', args);
    assert.equal(prepared.status, 'prepared');
    await assert.rejects(fs.lstat(path.join(root, 'new-bundle')));
    const executed = await dispatch('linmas_proof_create', { ...args, confirm_write: true });
    assert.equal(executed.status, 'executed');
    assert.equal(executed.proofOfImpact, 'not_claimed');
    assert.equal(executed.verification.integrity, 'valid');
    await assert.rejects(dispatch('linmas_proof_create', { ...args, confirm_write: true }), /already exists|WRITE_TARGET_EXISTS/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('review execute is prepared without consent and only executes a mocked provider after consent', async () => {
  const root = await setup();
  let calls = 0;
  const providerRegistry = new Map([['codex', {
    detectConfiguration: () => ({ status: 'configured', defaultModel: 'fixture-model' }),
    create: () => ({ run: async () => {
      calls += 1;
      return {
        provider: 'codex',
        model: 'fixture-model',
        usage: null,
        requestId: 'private-request-id',
        rawResponse: JSON.stringify({ schemaVersion: 1, scopeAndAssumptions: ['fixture'], findings: [], deterministicChecks: [], safetyBoundary })
      };
    } })
  }]]);
  try {
    const dispatch = createLinmasDispatcher({ providerRegistry });
    const args = { workspace_root: root, input_text: 'safe fixture', skill_name: 'secure-code-reviewer', provider: 'codex', confirm_transmission: false };
    const prepared = await dispatch('linmas_review_execute', args);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.dataLeavesMachine, false);
    assert.equal(calls, 0);
    assert.equal(prepared.provider.model, 'fixture-model');

    const executed = await dispatch('linmas_review_execute', { ...args, confirm_transmission: true });
    assert.equal(executed.status, 'executed');
    assert.equal(executed.dataLeavesMachine, true);
    assert.equal(executed.transmissionConfirmed, true);
    assert.equal(executed.review.modelMetadata.requestId, null);
    assert.equal(executed.transmissionState, 'normalized');
    assert.equal(executed.providerResponseReceived, true);
    assert.equal(executed.capsuleWritten, false);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stdio protocol returns discovery, tool invocation, and redacted error envelopes', async () => {
  const dispatcher = async (name) => {
    if (name === 'linmas_review_prepare') return { status: 'prepared', humanReviewRequired: true };
    throw Object.assign(new Error('provider stderr: Authorization: Bearer ghp_testsecret1234567890 token=do-not-return'), { category: 'provider-transport' });
  };
  const server = createStdioServer({ dispatcher });
  const initialized = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(initialized.result.serverInfo.name, 'linmas');
  assert.equal(initialized.result.serverInfo.version, SERVER_VERSION);
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 7);
  const called = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'linmas_review_prepare', arguments: {} } });
  assert.equal(called.result.structuredContent.status, 'prepared');
  const failed = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'linmas_review_execute', arguments: {} } });
  assert.equal(failed.result.isError, true);
  assert.doesNotMatch(failed.result.content[0].text, /ghp_|authorization|secret|stderr|token/i);
});

test('human review decision uses text fallback when the host cannot elicit', async () => {
  const server = createStdioServer({ dispatcher: createLinmasDispatcher() });
  const response = await server.handle({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'linmas_review_decide', arguments: {
      workspace_root: '/tmp/linmas-review-decision-test',
      review_result: { schemaVersion: 1, findings: [{ id: 'sql-1', severity: 'High' }] }
    } }
  });
  const interaction = response.result.structuredContent.reviewInteraction;
  assert.equal(interaction.channel, 'text_fallback');
  assert.equal(interaction.status, 'input_required');
  assert.deepEqual(interaction.options.map((option) => option.id), ['fix_requested', 'continue_with_note', 'manual_review_required', 'custom_instruction']);
});

test('MCP form elicitation routes the response while the tool call is pending', async () => {
  const outbound = [];
  const server = createStdioServer({
    dispatcher: createLinmasDispatcher(),
    sendRequest: (message) => outbound.push(message)
  });
  const initialized = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } } }
  });
  assert.equal(initialized.result.serverInfo.name, 'linmas');
  const call = server.handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'linmas_review_decide', arguments: {
      workspace_root: '/tmp/linmas-review-decision-test',
      review_result: { schemaVersion: 1, findings: [{ id: 'sql-1', severity: 'High' }] }
    } }
  });
  for (let attempt = 0; attempt < 20 && outbound.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].method, 'elicitation/create');
  assert.equal(outbound[0].params.mode, 'form');
  assert.ok(outbound[0].params.requestedSchema.properties.disposition);
  await server.handle({ jsonrpc: '2.0', id: outbound[0].id, result: { action: 'accept', content: { disposition: 'manual_review_required' } } });
  const response = await call;
  assert.equal(response.result.structuredContent.reviewInteraction.disposition, 'manual_review_required');
  assert.equal(server.pendingRequestCount, 0);
});

test('Critical/High continuation requires explicit risk acknowledgement', async () => {
  const dispatch = createLinmasDispatcher();
  await assert.rejects(dispatch('linmas_review_decide', {
    workspace_root: '/tmp/linmas-review-decision-test',
    review_result: { schemaVersion: 1, findings: [{ id: 'critical-1', severity: 'Critical' }] },
    decision: { disposition: 'continue_with_note' }
  }), /risk acknowledgement/i);
});
