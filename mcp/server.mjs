#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

import { fingerprintReviewInput, buildReviewCapsule } from '../src/review/build-capsule.mjs';
import { loadAndCompareCapsules } from '../src/review/compare-capsules.mjs';
import { prepareReview } from '../src/review/prepare-review.mjs';
import { preflightCapsuleDestination, writeReviewCapsule } from '../src/review/write-capsule.mjs';
import { validateReviewCapsule } from '../src/review/validate-capsule.mjs';
import { evaluatePolicy } from '../src/policy/evaluate-policy.mjs';
import { loadPolicyPack } from '../src/policy/load-pack.mjs';
import { loadProofEvidence } from '../src/proof/load-evidence.mjs';
import { buildDecisionReceipt } from '../src/proof/validate-receipt.mjs';
import { verifyProofBundle } from '../src/proof/verify-bundle.mjs';
import { writeProofBundle } from '../src/proof/write-bundle.mjs';
import { normalizeProviderResponse } from '../src/review/normalize-response.mjs';
import { toPublicReviewError } from '../src/review/public-error.mjs';
import { prepareProviderExecution, createProviderRegistry } from '../src/providers/registry.mjs';
import { PUBLIC_SKILL_IDS, SPECIALIST_IDENTIFIERS, resolveSkill } from '../src/core/skill-catalog.mjs';
import { LINMAS_VERSION } from '../src/core/version.mjs';

export const SERVER_NAME = 'linmas';
export const SERVER_VERSION = LINMAS_VERSION;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_PATH_LENGTH = 512;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_MCP_LINE_BYTES = 512 * 1024;
export const MAX_ARGUMENT_BYTES = MAX_MCP_LINE_BYTES;
export const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;
export const MAX_PROOF_TREE_BYTES = 32 * 1024 * 1024;
export const TOOL_TIMEOUTS = Object.freeze({
  read: { defaultMs: 30_000, maxMs: 60_000 },
  write: { defaultMs: 60_000, maxMs: 120_000 },
  transmit: { defaultMs: 120_000, maxMs: 180_000 }
});

const SPECIALIST_SKILL_IDS = Object.freeze(
  PUBLIC_SKILL_IDS.filter((skillId) => skillId !== 'linmas-security-domain-router')
);
const POLICY_IDS = Object.freeze(['baseline-appsec', 'cloud-change', 'release-security']);
const PROVIDER_IDS = Object.freeze(['claude', 'codex']);
const PROTOCOL_VERSION = '2025-11-25';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROAD_ROOTS = new Set(['/home', '/tmp', '/var', '/etc', '/usr', '/opt']);

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'linmas_review_prepare',
    title: 'Prepare Linmas Review',
    description: 'Prepare a bounded offline review request and specialist recommendation. This never calls a provider or writes files.',
    kind: 'read',
    inputSchema: inputSchema({
      input: true,
      specialist: true
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'linmas_review_compare',
    title: 'Compare Linmas Review Capsules',
    description: 'Validate and compare two local review capsules. Absence of a finding is not remediation proof.',
    kind: 'read',
    inputSchema: commonSchema({
      required: ['workspace_root', 'before_capsule_path', 'after_capsule_path'],
      properties: {
        before_capsule_path: relativePathSchema('Capsule produced before the change.'),
        after_capsule_path: relativePathSchema('Capsule produced after the change.')
      }
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'linmas_policy_evaluate',
    title: 'Evaluate Linmas Policy',
    description: 'Evaluate a local policy pack against a validated review capsule. This is a deterministic decision, not approval or certification.',
    kind: 'read',
    inputSchema: commonSchema({
      required: ['workspace_root', 'capsule_path'],
      properties: {
        capsule_path: relativePathSchema('Validated review capsule to evaluate.'),
        policy_id: { type: 'string', enum: POLICY_IDS },
        policy_path: relativePathSchema('Optional custom policy JSON; use exactly one of policy_id or policy_path.')
      },
      oneOf: [
        { required: ['policy_id'], not: { required: ['policy_path'] } },
        { required: ['policy_path'], not: { required: ['policy_id'] } }
      ]
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'linmas_proof_verify',
    title: 'Verify Linmas Proof Bundle',
    description: 'Verify local Proof Chain integrity, signature classification, source binding, and the mandatory human-review boundary.',
    kind: 'read',
    inputSchema: commonSchema({
      required: ['workspace_root', 'bundle_path'],
      properties: {
        bundle_path: relativePathSchema('Proof bundle directory to verify.'),
        allowed_signers_path: relativePathSchema('Optional local allowed-signers file for trusted signature classification.')
      }
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'linmas_proof_create',
    title: 'Create Linmas Proof Bundle',
    description: 'Create an immutable local Proof Chain bundle from validated evidence after explicit write confirmation. It never claims proof of impact.',
    kind: 'write',
    inputSchema: commonSchema({
      required: ['workspace_root', 'source_path', 'bundle_path', 'reviewer', 'findings', 'statement', 'confirm_write'],
      properties: {
        source_path: relativePathSchema('Capsule or sealed Codex Security scan used as evidence.'),
        bundle_path: relativePathSchema('New output directory. Existing targets are rejected.'),
        reviewer: reviewerSchema(),
        findings: {
          type: 'array',
          minItems: 0,
          maxItems: 256,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'disposition', 'rationale'],
            properties: {
              id: boundedStringSchema(16 * 1024),
              disposition: { enum: ['remediation-required', 'accepted-risk', 'false-positive', 'needs-more-evidence'] },
              rationale: boundedStringSchema(16 * 1024)
            }
          }
        },
        statement: boundedStringSchema(16 * 1024),
        confirm_write: { type: 'boolean' }
      }
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'linmas_review_execute',
    title: 'Execute Linmas Provider Review',
    description: 'Execute a provider-backed review only after explicit transmission consent. The returned review remains advisory and requires human review.',
    kind: 'transmit',
    inputSchema: commonSchema({
      required: ['workspace_root', 'skill_name', 'provider', 'confirm_transmission'],
      properties: {
        input_text: boundedStringSchema(MAX_INPUT_BYTES),
        input_path: relativePathSchema('Local input file to send after explicit consent.'),
        skill_name: { type: 'string', enum: SPECIALIST_IDENTIFIERS },
        provider: { type: 'string', enum: PROVIDER_IDS },
        model: boundedStringSchema(512),
        policy_id: { type: 'string', enum: POLICY_IDS },
        policy_path: relativePathSchema('Optional custom local policy JSON.'),
        capsule_path: relativePathSchema('Optional new capsule output path; existing targets are rejected.'),
        confirm_transmission: { type: 'boolean' }
      },
      oneOf: [
        { required: ['input_text'], not: { required: ['input_path'] } },
        { required: ['input_path'], not: { required: ['input_text'] } }
      ]
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
]);

export function listTools() {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations
  }));
}

export function createLinmasDispatcher({
  pluginRoot = PLUGIN_ROOT,
  env = process.env,
  providerRegistry = null,
  providerRegistryFactory = createProviderRegistry
} = {}) {
  const registry = providerRegistry ?? providerRegistryFactory({ env });

  return async function dispatchTool(name, rawArguments = {}) {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition) throw toolError('unknown_tool', 'unknown tool', undefined, {
      stage: 'argument-validation',
      reasonCode: 'TOOL_UNSUPPORTED'
    });
    const args = validateToolArguments(definition, rawArguments);
    const timeoutMs = args.timeout_ms ?? TOOL_TIMEOUTS[definition.kind].defaultMs;
    const operation = (signal) => {
      switch (name) {
        case 'linmas_review_prepare': return reviewPrepare(args);
        case 'linmas_review_compare': return reviewCompare(args, signal);
        case 'linmas_policy_evaluate': return policyEvaluate(args, pluginRoot, signal);
        case 'linmas_proof_verify': return proofVerify(args, signal);
        case 'linmas_proof_create': return proofCreate(args, signal);
        case 'linmas_review_execute': return reviewExecute(args, pluginRoot, registry, env, signal);
        default: throw toolError('unknown_tool', 'unknown tool', undefined, {
          stage: 'argument-validation',
          reasonCode: 'TOOL_UNSUPPORTED'
        });
      }
    };
    return boundedOutput(await withTimeout(operation, timeoutMs));
  };
}

function inputSchema({ input = false, specialist = false } = {}) {
  const properties = {
    input_text: boundedStringSchema(MAX_INPUT_BYTES),
    input_path: relativePathSchema('Local input file inside workspace_root.'),
    ...(specialist ? { skill_name: { type: 'string', enum: SPECIALIST_IDENTIFIERS } } : {})
  };
  return commonSchema({
    required: ['workspace_root'],
    properties,
    ...(input ? {
      oneOf: [
        { required: ['input_text'], not: { required: ['input_path'] } },
        { required: ['input_path'], not: { required: ['input_text'] } }
      ]
    } : {})
  });
}

function commonSchema({ required = [], properties = {}, oneOf = [] } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...new Set(required)],
    properties: {
      workspace_root: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH, description: 'Absolute workspace root that confines every local path.' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: TOOL_TIMEOUTS.transmit.maxMs, description: 'Optional bounded operation timeout in milliseconds.' },
      ...properties
    },
    ...(oneOf.length ? { oneOf } : {})
  };
}

function relativePathSchema(description) {
  return { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH, description };
}

function boundedStringSchema(maxLength) {
  return { type: 'string', minLength: 1, maxLength };
}

function reviewerSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'principal'],
    properties: { label: boundedStringSchema(16 * 1024), principal: { anyOf: [{ type: 'string', minLength: 1, maxLength: 16 * 1024 }, { type: 'null' }] } }
  };
}

function validateToolArguments(definition, value) {
  object(value, 'arguments');
  let serializedArguments;
  try {
    serializedArguments = JSON.stringify(value);
  } catch (cause) {
    throw toolError('invalid_input', 'arguments must be JSON-serializable', cause);
  }
  if (Buffer.byteLength(serializedArguments, 'utf8') > MAX_ARGUMENT_BYTES) {
    throw toolError('input_too_large', 'arguments exceed the bounded MCP frame limit');
  }
  const allowed = new Set(Object.keys(definition.inputSchema.properties));
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw toolError('input_field_unsupported', `unknown input field: ${key}`, undefined, { field: key, stage: 'argument-validation', reasonCode: 'UNKNOWN_FIELD' });
  for (const key of definition.inputSchema.required ?? []) if (!Object.hasOwn(value, key)) throw toolError('input_field_required', `missing input field: ${key}`, undefined, { field: key, stage: 'argument-validation', reasonCode: 'REQUIRED_FIELD_MISSING' });
  const workspace = value.workspace_root;
  boundedString(workspace, 'workspace_root', MAX_PATH_LENGTH);
  if (!path.isAbsolute(workspace) || hasTraversal(workspace)) throw toolError('invalid_path', 'workspace_root must be an absolute path without traversal', undefined, { stage: 'workspace-validation', reasonCode: 'WORKSPACE_ROOT_INVALID' });
  if (value.timeout_ms !== undefined && (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 100 || value.timeout_ms > TOOL_TIMEOUTS[definition.kind].maxMs)) {
    throw toolError('invalid_input', 'timeout_ms is outside the bounded tool limit');
  }
  for (const key of ['input_path', 'before_capsule_path', 'after_capsule_path', 'capsule_path', 'bundle_path', 'source_path', 'allowed_signers_path', 'policy_path']) {
    if (value[key] !== undefined) validatePortableRelativePath(value[key], key);
  }
  if (value.input_text !== undefined) boundedString(value.input_text, 'input_text', MAX_INPUT_BYTES);
  if (value.skill_name !== undefined) {
    const skill = resolveSkill(value.skill_name);
    if (!skill || skill.kind !== 'specialist') {
      throw toolError('specialist_unsupported', 'skill_name must identify a Linmas specialist', undefined, {
        field: 'skill_name', stage: 'argument-validation', reasonCode: 'SPECIALIST_UNSUPPORTED',
        allowedValues: SPECIALIST_SKILL_IDS
      });
    }
    value = { ...value, skill_name: skill.skillId };
  }
  if (value.provider !== undefined && !PROVIDER_IDS.includes(value.provider)) throw toolError('provider_unsupported', 'provider is unsupported', undefined, { field: 'provider', stage: 'argument-validation', reasonCode: 'PROVIDER_UNSUPPORTED', allowedValues: PROVIDER_IDS });
  if (value.model !== undefined) boundedString(value.model, 'model', 512);
  if (value.policy_id !== undefined && !POLICY_IDS.includes(value.policy_id)) throw toolError('policy_unsupported', 'policy_id is unsupported', undefined, { field: 'policy_id', stage: 'argument-validation', reasonCode: 'POLICY_UNSUPPORTED', allowedValues: POLICY_IDS });
  if (value.policy_id !== undefined && value.policy_path !== undefined) throw toolError('invalid_input', 'provide exactly one policy_id or policy_path');
  if (definition.name === 'linmas_policy_evaluate' && value.policy_id === undefined && value.policy_path === undefined) throw toolError('invalid_input', 'policy_id or policy_path is required');
  if (definition.name === 'linmas_policy_evaluate' && value.policy_id === undefined && value.policy_path === undefined) throw toolError('invalid_input', 'policy_id or policy_path is required');
  if (definition.name === 'linmas_proof_create') validateProofCreateArguments(value);
  if (definition.name === 'linmas_review_execute') validateReviewExecuteArguments(value);
  return value;
}

function validateProofCreateArguments(value) {
  if (typeof value.confirm_write !== 'boolean') throw toolError('invalid_input', 'confirm_write must be boolean');
  object(value.reviewer, 'reviewer');
  exactKeys(value.reviewer, ['label', 'principal'], 'reviewer');
  boundedString(value.reviewer.label, 'reviewer.label', 16 * 1024);
  if (value.reviewer.principal !== null) boundedString(value.reviewer.principal, 'reviewer.principal', 16 * 1024);
  if (!Array.isArray(value.findings) || value.findings.length > 256) throw toolError('invalid_input', 'findings must contain at most 256 items');
  for (const finding of value.findings) {
    object(finding, 'finding');
    exactKeys(finding, ['id', 'disposition', 'rationale'], 'finding');
    boundedString(finding.id, 'finding.id', 16 * 1024);
    if (!['remediation-required', 'accepted-risk', 'false-positive', 'needs-more-evidence'].includes(finding.disposition)) throw toolError('invalid_input', 'finding disposition is invalid');
    boundedString(finding.rationale, 'finding.rationale', 16 * 1024);
  }
  boundedString(value.statement, 'statement', 16 * 1024);
}

function validateReviewExecuteArguments(value) {
  if (typeof value.confirm_transmission !== 'boolean') throw toolError('input_field_invalid', 'confirm_transmission must be boolean', undefined, { field: 'confirm_transmission', stage: 'argument-validation', reasonCode: 'FIELD_TYPE_INVALID' });
  if (!value.input_text && !value.input_path) throw toolError('input_source_invalid', 'provide exactly one input_text or input_path', undefined, { stage: 'argument-validation', reasonCode: 'INPUT_SOURCE_REQUIRED' });
  if (value.input_text !== undefined && value.input_path !== undefined) throw toolError('input_source_invalid', 'provide exactly one input_text or input_path', undefined, { stage: 'argument-validation', reasonCode: 'INPUT_SOURCE_CONFLICT' });
  if (value.policy_id !== undefined && value.policy_path !== undefined) throw toolError('invalid_input', 'provide exactly one policy_id or policy_path');
}

async function reviewPrepare(args) {
  const workspace = await validateWorkspaceRoot(args.workspace_root);
  const input = await readReviewInput(args, workspace);
  const request = prepareReview({ input, skillName: args.skill_name ?? null });
  return {
    status: 'prepared',
    operation: 'review_prepare',
    dataLeavesMachine: false,
    humanReviewRequired: true,
    reviewState: 'needs_human_review',
    request
  };
}

async function reviewCompare(args) {
  const workspace = await validateWorkspaceRoot(args.workspace_root);
  const before = await resolveExisting(workspace, args.before_capsule_path, 'capsule');
  const after = await resolveExisting(workspace, args.after_capsule_path, 'capsule');
  const delta = await loadAndCompareCapsules(before, after, { cwd: workspace });
  return {
    status: 'verified',
    operation: 'review_compare',
    dataLeavesMachine: false,
    humanReviewRequired: true,
    reviewState: 'needs_human_review',
    delta
  };
}

async function policyEvaluate(args, pluginRoot) {
  const workspace = await validateWorkspaceRoot(args.workspace_root);
  const capsulePath = await resolveExisting(workspace, args.capsule_path, 'capsule');
  const capsule = await readValidatedCapsule(capsulePath);
  const policy = await loadPolicyForArguments(args, workspace, pluginRoot);
  const result = evaluatePolicy(policy, capsule.review);
  return {
    status: 'verified',
    operation: 'policy_evaluate',
    dataLeavesMachine: false,
    humanReviewRequired: true,
    reviewState: 'needs_human_review',
    policy: result
  };
}

async function proofVerify(args) {
  const workspace = await validateWorkspaceRoot(args.workspace_root);
  const bundle = await resolveExisting(workspace, args.bundle_path, 'proof bundle', { directory: true });
  await assertBoundedTree(bundle, MAX_PROOF_TREE_BYTES, 'proof bundle');
  const allowedSigners = args.allowed_signers_path
    ? await resolveExisting(workspace, args.allowed_signers_path, 'allowed signers')
    : null;
  const result = await verifyProofBundle(bundle, { allowedSignersPath: allowedSigners });
  return {
    status: 'verified',
    operation: 'proof_verify',
    dataLeavesMachine: false,
    humanReviewRequired: true,
    reviewState: 'needs_human_review',
    verification: {
      integrity: result.integrity,
      signature: result.signature,
      identity: result.identity,
      source: result.source,
      manifestSha256: result.manifestSha256,
      receipt: {
        overallDisposition: result.receipt.summary.overallDisposition,
        findingIds: result.receipt.findings.map((finding) => finding.id)
      }
    }
  };
}

async function proofCreate(args, signal) {
  const workspace = await validateWorkspaceRoot(args.workspace_root);
  throwIfAborted(signal);
  const sourcePath = await resolveExisting(workspace, args.source_path, 'proof source');
  throwIfAborted(signal);
  await assertBoundedTree(sourcePath, MAX_PROOF_TREE_BYTES, 'proof source');
  throwIfAborted(signal);
  const destination = await prepareNewDirectory(workspace, args.bundle_path, 'proof bundle');
  throwIfAborted(signal);
  if (!args.confirm_write) {
    return {
      status: 'prepared',
      operation: 'proof_create',
      dataLeavesMachine: false,
      humanReviewRequired: true,
      reviewState: 'needs_human_review',
      write: { confirmed: false, sourcePath: args.source_path, bundlePath: args.bundle_path, signing: false }
    };
  }
  throwIfAborted(signal);
  const source = await awaitWithAbort(signal, () => loadProofEvidence(sourcePath));
  throwIfAborted(signal);
  const receipt = buildDecisionReceipt({
    subject: { kind: source.kind, sha256: source.sourceSha256 },
    reviewer: args.reviewer,
    findings: args.findings,
    statement: args.statement
  });
  throwIfAborted(signal);
  let created;
  try {
    throwIfAborted(signal);
    created = await writeProofBundle(destination, source, receipt, { signal });
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted && created?.path) await fs.rm(created.path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  throwIfAborted(signal);
  const verified = await awaitWithAbort(signal, () => verifyProofBundle(created.path));
  throwIfAborted(signal);
  return {
    status: 'executed',
    operation: 'proof_create',
    dataLeavesMachine: false,
    humanReviewRequired: true,
    reviewState: 'needs_human_review',
    proofOfImpact: 'not_claimed',
    bundlePath: args.bundle_path,
    verification: {
      integrity: verified.integrity,
      signature: verified.signature,
      identity: verified.identity,
      manifestSha256: verified.manifestSha256
    }
  };
}

async function reviewExecute(args, pluginRoot, registry, env, signal) {
  const transmission = { state: 'not-attempted' };
  const states = ['not-attempted', 'attempted', 'response-received', 'normalized', 'capsule-written'];
  const advanceTransmission = (state) => {
    if (states.indexOf(state) > states.indexOf(transmission.state)) transmission.state = state;
  };
  const annotateFailure = (error) => {
    if (error && typeof error === 'object') {
      const errorState = states.includes(error.transmissionState) ? error.transmissionState : 'not-attempted';
      const finalState = states.indexOf(errorState) > states.indexOf(transmission.state) ? errorState : transmission.state;
      error.transmissionState = finalState;
      error.transmissionAttempted = finalState !== 'not-attempted';
      error.providerResponseReceived = ['response-received', 'normalized', 'capsule-written'].includes(finalState);
      error.capsuleWritten = finalState === 'capsule-written';
      error.stage ??= finalState === 'not-attempted' ? 'provider-preflight' : 'provider-execution';
    }
    return error;
  };

  try {
    const workspace = await validateWorkspaceRoot(args.workspace_root);
    throwIfAborted(signal);
    const preview = providerPreview(args.provider, args.model, env, registry);
    if (!args.confirm_transmission) {
      return {
        status: 'prepared',
        operation: 'review_execute',
        dataLeavesMachine: false,
        transmissionRequired: true,
        humanReviewRequired: true,
        reviewState: 'needs_human_review',
        transmissionState: transmission.state,
        transmissionAttempted: false,
        providerResponseReceived: false,
        capsuleWritten: false,
        provider: preview
      };
    }

    const execution = await withDeadlineSignal(signal, async (executionSignal) => prepareProviderExecution(registry, args.provider, {
      model: args.model,
      cwd: workspace,
      signal: executionSignal,
      capabilityTimeoutMs: args.timeout_ms ?? TOOL_TIMEOUTS.transmit.defaultMs
    }));
    const executionMetadata = { ...execution.metadata };
    throwIfAborted(signal);
    const input = await awaitWithAbort(signal, () => readReviewInput(args, workspace));
    throwIfAborted(signal);
    const request = prepareReview({ input, skillName: args.skill_name });
    throwIfAborted(signal);
    const capsuleTarget = args.capsule_path
      ? await awaitWithAbort(signal, async () => preflightCapsuleDestination(await prepareNewFile(workspace, args.capsule_path, 'capsule'), { cwd: workspace }))
      : null;
    throwIfAborted(signal);
    const policy = args.policy_id || args.policy_path ? await awaitWithAbort(signal, () => loadPolicyForArguments(args, workspace, pluginRoot)) : null;
    throwIfAborted(signal);
    const runner = execution.createRunner();
    advanceTransmission('attempted');
    const runResult = await withDeadlineSignal(signal, (executionSignal) => runner.run({
      system: 'Return only ReviewResult schemaVersion 1 JSON.',
      user: JSON.stringify(request),
      signal: executionSignal
    }));
    throwIfAborted(signal);
    advanceTransmission('response-received');
    const review = normalizeProviderResponse(runResult, { caseId: 'review/linmas-mcp', specialist: request.specialist });
    throwIfAborted(signal);
    advanceTransmission('normalized');
    review.modelMetadata.requestId = null;
    let policyResult = null;
    if (policy) {
      throwIfAborted(signal);
      policyResult = evaluatePolicy(policy, review);
      throwIfAborted(signal);
    }
    if (capsuleTarget) {
      throwIfAborted(signal);
      const capsule = buildReviewCapsule({
        input: { source: input.source, bytes: input.bytes, sha256: input.sha256 },
        execution: { mode: 'live', provider: review.modelMetadata.provider, authMode: executionMetadata.authMode, model: review.modelMetadata.model, modelVerified: executionMetadata.modelVerified === true && executionMetadata.model === review.modelMetadata.model },
        review,
        policyResult
      });
      throwIfAborted(signal);
      try {
        throwIfAborted(signal);
        await writeReviewCapsule(capsuleTarget, capsule, { signal });
        throwIfAborted(signal);
      } catch (error) {
        if (signal?.aborted) await fs.rm(capsuleTarget.path, { force: true }).catch(() => {});
        throw error;
      }
      advanceTransmission('capsule-written');
      throwIfAborted(signal);
    }
    return {
      status: 'executed',
      operation: 'review_execute',
      dataLeavesMachine: true,
      transmissionConfirmed: true,
      humanReviewRequired: true,
      reviewState: 'needs_human_review',
      transmissionState: transmission.state,
      transmissionAttempted: true,
      providerResponseReceived: true,
      capsuleWritten: transmission.state === 'capsule-written',
      provider: {
        provider: executionMetadata.provider,
        model: executionMetadata.model,
        authMode: executionMetadata.authMode,
        modelVerified: executionMetadata.modelVerified === true
      },
      capsulePath: args.capsule_path ?? null,
      review,
      policy: policyResult
    };
  } catch (error) {
    throw annotateFailure(error);
  }
}

function providerPreview(provider, model, env, registry) {
  const descriptor = registry.get(provider);
  const configuration = descriptor?.detectConfiguration?.({ env, model }) ?? { status: 'unknown', defaultModel: null, missingRequirements: [] };
  return {
    provider,
    model: model ?? configuration.defaultModel ?? 'provider default',
    authMode: configuration.status === 'configured' ? 'configured' : 'unavailable',
    modelVerified: false,
    configurationStatus: configuration.status,
    missingRequirements: Array.isArray(configuration.missingRequirements) ? configuration.missingRequirements : []
  };
}

async function readReviewInput(args, workspace) {
  const hasText = args.input_text !== undefined;
  const hasPath = args.input_path !== undefined;
  if (hasText === hasPath) throw toolError('invalid_input', 'provide exactly one input_text or input_path');
  let bytes;
  let source;
  if (hasText) {
    bytes = Buffer.from(args.input_text, 'utf8');
    source = 'inline';
  } else {
    const target = await resolveExisting(workspace, args.input_path, 'input');
    const stat = await fs.lstat(target);
    if (stat.size > MAX_INPUT_BYTES) throw toolError('input_too_large', 'input exceeds the bounded 64 KiB limit');
    bytes = await fs.readFile(target);
    source = args.input_path;
  }
  if (bytes.byteLength > MAX_INPUT_BYTES) throw toolError('input_too_large', 'input exceeds the bounded 64 KiB limit');
  if (bytes.includes(0)) throw toolError('invalid_input', 'binary input is not supported');
  return { source, content: bytes.toString('utf8'), bytes: bytes.byteLength, sha256: fingerprintReviewInput(bytes) };
}

async function readValidatedCapsule(capsulePath) {
  let stat;
  try { stat = await fs.lstat(capsulePath); } catch { throw toolError('invalid_path', 'capsule does not exist'); }
  if (stat.size > MAX_CAPSULE_BYTES) throw toolError('input_too_large', 'capsule exceeds the bounded 2 MiB limit');
  const text = await fs.readFile(capsulePath, 'utf8');
  try { return validateReviewCapsule(JSON.parse(text)); }
  catch (cause) { throw toolError('contract_violation', 'review capsule failed Linmas validation', cause); }
}

async function loadPolicyForArguments(args, workspace, pluginRoot) {
  const policyPath = args.policy_path ? await resolveExisting(workspace, args.policy_path, 'policy') : null;
  try {
    return loadPolicyPack({ id: args.policy_id ?? null, filePath: policyPath, rootDir: pluginRoot, cwd: workspace });
  } catch (cause) { throw toolError('contract_violation', 'policy pack failed Linmas validation', cause); }
}

async function validateWorkspaceRoot(rawRoot) {
  const root = path.resolve(rawRoot);
  if (BROAD_ROOTS.has(root) || root === path.parse(root).root) throw toolError('invalid_path', 'workspace_root is too broad');
  let stat;
  try { stat = await fs.lstat(root); } catch { throw toolError('invalid_path', 'workspace_root is not accessible'); }
  if (stat.isSymbolicLink()) throw toolError('invalid_path', 'workspace_root must not resolve through a symlink');
  if (!stat.isDirectory()) throw toolError('invalid_path', 'workspace_root must be a regular directory');
  await assertNoSymlinkPathComponents(root);
  try { await fs.realpath(root); } catch { throw toolError('invalid_path', 'workspace_root could not be resolved'); }
  return root;
}

async function assertNoSymlinkPathComponents(target) {
  const filesystemRoot = path.parse(target).root;
  let current = filesystemRoot;
  for (const segment of target.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch { throw toolError('invalid_path', 'workspace_root is not accessible'); }
    if (stat.isSymbolicLink()) throw toolError('invalid_path', 'workspace_root must not resolve through a symlink');
  }
}

async function resolveExisting(workspace, rawPath, label, { directory = false } = {}) {
  const target = resolveRelative(workspace, rawPath, label);
  await assertNoSymlinkComponents(workspace, target);
  let stat;
  try { stat = await fs.lstat(target); } catch { throw toolError('invalid_path', `${label} does not exist`); }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw toolError('invalid_path', `${label} must be a regular non-symlink ${directory ? 'directory' : 'file'}`);
  return target;
}

async function prepareNewFile(workspace, rawPath, label) {
  const target = resolveRelative(workspace, rawPath, label);
  await assertNoSymlinkComponents(workspace, path.dirname(target), { allowWorkspaceRoot: true });
  let parent;
  try { parent = await fs.lstat(path.dirname(target)); } catch { throw toolError('invalid_path', `${label} parent does not exist`); }
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw toolError('invalid_path', `${label} parent must be a regular directory`);
  try { await fs.lstat(target); throw toolError('write_target_exists', `${label} already exists`); } catch (cause) { if (cause?.code !== 'ENOENT' && cause?.category !== 'write_target_exists') throw cause; }
  return target;
}

async function prepareNewDirectory(workspace, rawPath, label) {
  const target = await prepareNewFile(workspace, rawPath, label);
  return target;
}

async function assertNoSymlinkComponents(workspace, target, { allowWorkspaceRoot = false } = {}) {
  const relative = path.relative(workspace, target);
  if ((!allowWorkspaceRoot && relative === '') || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw toolError('invalid_path', 'path is outside workspace_root');
  let current = workspace;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw toolError('invalid_path', 'path contains a symlink');
    } catch (cause) {
      if (cause?.code === 'ENOENT') break;
      throw cause;
    }
  }
}

async function assertBoundedTree(target, maxBytes, label, state = { bytes: 0, entries: 0 }) {
  let stat;
  try { stat = await fs.lstat(target); } catch { throw toolError('invalid_path', `${label} could not be inspected`); }
  if (stat.isSymbolicLink()) throw toolError('invalid_path', `${label} contains a symlink`);
  state.entries += 1;
  if (state.entries > 4096) throw toolError('input_too_large', `${label} contains too many entries`);
  if (stat.isFile()) {
    state.bytes += stat.size;
    if (state.bytes > maxBytes) throw toolError('input_too_large', `${label} exceeds the bounded size limit`);
    return state;
  }
  if (!stat.isDirectory()) throw toolError('invalid_path', `${label} contains a non-regular entry`);
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    await assertBoundedTree(path.join(target, entry.name), maxBytes, label, state);
  }
  return state;
}

function resolveRelative(workspace, rawPath, label) {
  validatePortableRelativePath(rawPath, label);
  const target = path.resolve(workspace, rawPath);
  const relative = path.relative(workspace, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw toolError('invalid_path', `${label} must remain inside workspace_root`);
  return target;
}

export function validatePortableRelativePath(value, field, { platform = process.platform, pathImpl = path } = {}) {
  boundedString(value, field, MAX_PATH_LENGTH);
  const segments = platform === 'win32' ? /[\\/]/u : /\//u;
  const hasWindowsSeparatorOnPosix = platform !== 'win32' && value.includes('\\');
  if (pathImpl.isAbsolute(value) || hasWindowsSeparatorOnPosix || value.split(segments).some((segment) => segment === '..')) {
    throw toolError('invalid_path', `${field} must be a relative path without traversal`);
  }
}

function boundedOutput(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_BYTES) throw toolError('output_too_large', 'tool output exceeds the bounded 256 KiB limit');
  return value;
}

function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const operationPromise = Promise.resolve()
    .then(() => operation(controller.signal))
    .then((result) => {
      throwIfAborted(controller.signal);
      return result;
    });
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(toolError('timeout', 'tool operation timed out'));
      reject(toolError('timeout', 'tool operation timed out'));
    }, timeoutMs);
  });
  return Promise.race([operationPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function withDeadlineSignal(parentSignal, operation) {
  if (parentSignal?.aborted) return Promise.reject(toolError('timeout', 'tool operation was cancelled'));
  return operation(parentSignal);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw toolError('timeout', 'tool operation was cancelled');
}

async function awaitWithAbort(signal, operation) {
  throwIfAborted(signal);
  const result = await operation();
  throwIfAborted(signal);
  return result;
}

function validateRelativeString(value, field, maxLength) {
  boundedString(value, field, maxLength);
  return value;
}

function exactKeys(value, keys, field) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw toolError('invalid_input', `${field} contains an unknown field`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw toolError('invalid_input', `${field}.${key} is required`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw toolError('invalid_input', `${field} must be an object`);
}

function boundedString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw toolError('invalid_input', `${field} must be a non-empty string`);
  if (value.length > maxLength || value.includes('\0')) throw toolError('invalid_input', `${field} exceeds the bounded string contract`);
}

function hasTraversal(value) {
  return value.split(/[\\/]/u).some((segment) => segment === '..');
}

function toolError(code, message, cause = undefined, metadata = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.toolCode = code;
  Object.assign(error, metadata);
  return error;
}

function safeError(error, { transmitting = false } = {}) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') error.toolCode = 'timeout';
  return toPublicReviewError(error, { transmitting });
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } };
}

function jsonRpcToolError(id, error, transmitting = false) {
  const safe = safeError(error, { transmitting });
  const envelope = { status: 'needs_human_review', error: safe };
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope } };
}

export function createStdioServer({ dispatcher = createLinmasDispatcher() } = {}) {
  return {
    async handle(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
      const { id, method, params } = message;
      if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: { protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: 'Linmas MCP tools are bounded. Offline tools do not transmit data. Review execution requires explicit confirm_transmission=true; writes require confirm_write=true. Results remain advisory and require human review.' } };
      }
      if (method === 'notifications/initialized' || method === 'ping') return method === 'ping' ? { jsonrpc: '2.0', id, result: {} } : null;
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: listTools() } };
      if (method === 'tools/call') {
        const name = params?.name;
        try {
          const result = await dispatcher(name, params?.arguments ?? {});
          return jsonRpcResult(id, result);
        } catch (error) {
          return jsonRpcToolError(id, error, name === 'linmas_review_execute');
        }
      }
      if (id === undefined) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
  };
}

async function runStdio() {
  const server = createStdioServer();
  await readBoundedJsonLines(process.stdin, {
    onMessage: async (message) => {
    const response = await server.handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}

export async function readBoundedJsonLines(input, { maxBytes = MAX_MCP_LINE_BYTES, onMessage = async () => {}, onInvalid = () => {} } = {}) {
  if (!input || typeof input[Symbol.asyncIterator] !== 'function') throw new TypeError('MCP input must be an async iterable');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('MCP line limit must be a positive integer');

  let pending = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const consumeLine = async (line) => {
    const withoutCr = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    if (withoutCr.length === 0) return;
    let text;
    try {
      text = decoder.decode(withoutCr);
    } catch {
      await onInvalid({ code: 'INVALID_UTF8' });
      return;
    }
    try {
      const message = JSON.parse(text);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('JSON message must be an object');
      await onMessage(message);
    } catch {
      await onInvalid({ code: 'MALFORMED_JSON' });
    }
  };

  try {
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const fragment = chunk.subarray(offset, end);
        if (pending.length + fragment.length > maxBytes) throw toolError('input_too_large', `MCP line exceeds the bounded ${maxBytes}-byte limit`);
        if (fragment.length > 0) pending = pending.length === 0 ? Buffer.from(fragment) : Buffer.concat([pending, fragment], pending.length + fragment.length);
        if (newline === -1) break;
        await consumeLine(pending);
        pending = Buffer.alloc(0);
        offset = newline + 1;
      }
    }
    if (pending.length > 0) await consumeLine(pending);
  } catch (error) {
    if (typeof input.destroy === 'function') input.destroy();
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url)) && process.argv.includes('--stdio')) {
  runStdio().catch(() => { process.exitCode = 1; });
}
