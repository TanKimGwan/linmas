#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProviderResponse } from '../src/review/normalize-response.mjs';
import { loadPolicyPack } from '../src/policy/load-pack.mjs';
import { evaluatePolicy } from '../src/policy/evaluate-policy.mjs';
import { buildReviewCapsule, fingerprintReviewInput } from '../src/review/build-capsule.mjs';
import { preflightCapsuleDestination, writeReviewCapsule } from '../src/review/write-capsule.mjs';
import { runReview } from '../src/review/run-review.mjs';
import { createProviderRegistry } from '../src/providers/registry.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const INPUT_SOURCE = 'examples/build-week/insecure-query.diff';
const RESULT_SOURCE = 'examples/build-week/offline-review-result.json';
const USAGE = 'usage: npm run demo:judge -- [--live --yes] [--model <account-visible-model>] [--capsule <path>]';

export async function runBuildWeekDemo(argv = [], {
  rootDir = DEFAULT_ROOT,
  io = process,
  now = () => new Date(),
  runReviewImpl = runReview,
  createProviderRegistryImpl = createProviderRegistry
} = {}) {
  let options;
  try { options = parseOptions(argv); }
  catch (error) { io.stderr.write(`Error: ${error.message}\n${USAGE}\n`); return 2; }
  if (options.help) { io.stdout.write(`${USAGE}\n`); return 0; }
  if (options.live && !options.yes) {
    io.stderr.write('Error: live demo requires --yes to confirm synthetic input transmission.\n');
    return 2;
  }

  try {
    if (options.live) {
      const result = await runReviewImpl({
        inputPath: INPUT_SOURCE,
        useStdin: false,
        skillName: 'linmas-secure-code-reviewer',
        provider: 'codex',
        model: options.model,
        output: 'text',
        assumeYes: true,
        policyId: 'baseline-appsec',
        policyFile: null,
        capsulePath: options.capsulePath
      }, {
        io: { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, isTTY: false },
        cwd: rootDir,
        rootDir,
        providerRegistry: createProviderRegistryImpl(),
        loadPolicy: loadPolicyPack,
        now
      });
      io.stdout.write(result.output);
      return result.exitCode;
    }

    const inputPath = path.join(rootDir, INPUT_SOURCE);
    const resultPath = path.join(rootDir, RESULT_SOURCE);
    const [inputBytes, rawResponse] = await Promise.all([
      fs.readFile(inputPath),
      fs.readFile(resultPath, 'utf8')
    ]);
    const review = normalizeProviderResponse({
      provider: 'fixture',
      model: 'offline-review-fixture',
      rawResponse,
      usage: null,
      requestId: null
    }, { caseId: 'build-week/insecure-query', specialist: 'secure-code-reviewer' });
    const policy = loadPolicyPack({ id: 'baseline-appsec', rootDir });
    const policyResult = evaluatePolicy(policy, review);
    const capsule = buildReviewCapsule({
      input: { source: INPUT_SOURCE, bytes: inputBytes.length, sha256: fingerprintReviewInput(inputBytes) },
      execution: {
        mode: 'offline-fixture',
        provider: 'fixture',
        authMode: 'unavailable',
        model: 'offline-review-fixture',
        modelVerified: false
      },
      review,
      policyResult,
      now: now()
    });

    let capsuleStatus = 'validated in memory';
    if (options.capsulePath) {
      const target = await preflightCapsuleDestination(options.capsulePath);
      await writeReviewCapsule(target, capsule);
      capsuleStatus = 'written to requested destination';
    }
    io.stdout.write(formatOfflineSummary({ inputBytes: inputBytes.length, review, policyResult, capsuleStatus }));
    return 0;
  } catch (error) {
    io.stderr.write(`Error: ${sanitizeError(error, rootDir)}\n`);
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}

function parseOptions(argv) {
  const options = { live: false, yes: false, model: null, capsulePath: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--model') {
      options.model = argv[++index];
      if (!options.model) throw new Error('--model requires an account-visible model');
    }
    else if (arg === '--capsule') {
      options.capsulePath = argv[++index];
      if (!options.capsulePath) throw new Error('--capsule requires a path');
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function formatOfflineSummary({ inputBytes, review, policyResult, capsuleStatus }) {
  return [
    'LINMAS PROOF REVIEW',
    '',
    'Execution            OFFLINE FIXTURE REPLAY — NO MODEL CALL',
    `Input                synthetic insecure query diff (${inputBytes} bytes)`,
    'Specialist           linmas-secure-code-reviewer',
    'Authentication       unavailable (offline)',
    'Model                offline-review-fixture',
    'Contract validation  PASSED',
    `Findings             ${review.findings.length} (${review.findings[0]?.severity ?? 'none'})`,
    `Policy decision      ${policyResult.decision.toUpperCase()}`,
    'Human review         REQUIRED',
    `Review Capsule       ${capsuleStatus}`,
    '',
    'This fixture replay is reproducible evidence, not a live model claim or security guarantee.',
    ''
  ].join('\n');
}

function sanitizeError(error, rootDir) {
  return String(error?.message ?? error ?? 'demo failed')
    .split(rootDir).join('<package>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 512);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBuildWeekDemo(process.argv.slice(2));
}

export { INPUT_SOURCE, RESULT_SOURCE, USAGE };
