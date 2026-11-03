#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgv } from '../src/cli/parse-args.mjs';
import { listSkills } from '../src/core/list-skills.mjs';
import { detectHosts } from '../src/core/detect-hosts.mjs';
import { readManifest, readScopedManifest } from '../src/core/manifest.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';
import { formatOnboarding, inspectCodexCapability } from '../src/core/onboard.mjs';
import { selectSkills, selectTargets, planInstall, formatInstallPreview, formatInstallSummary, applyInstallPlan, promptForInstallChoices, promptForInstallTarget, promptForInstallConfirmation } from '../src/core/install-skills.mjs';
import { createTimestamp } from '../src/core/fs-utils.mjs';
import { planUninstall, formatUninstallPreview, applyUninstallPlan, promptForUninstallChoices, promptForUninstallTarget, promptForUninstallConfirmation } from '../src/core/uninstall-skills.mjs';
import { runReview } from '../src/review/run-review.mjs';
import { ReviewError } from '../src/review/errors.mjs';
import { createProviderRegistry } from '../src/providers/registry.mjs';
import { createHostRegistry } from '../src/hosts/registry.mjs';
import { LINMAS_VERSION } from '../src/core/version.mjs';
import {
  applyScopedInstallPlan,
  applyScopedUninstallPlan,
  formatScopedDoctorReport,
  formatScopedInstallPreview,
  formatScopedUninstallPreview,
  planScopedInstall,
  planScopedUninstall,
  promptForScopedConfirmation,
  promptForScopedSelection,
  selectScopedSkills
} from '../src/core/scoped-skills.mjs';
import { loadPolicyPack } from '../src/policy/load-pack.mjs';
import { formatSecurityDelta, loadAndCompareCapsules } from '../src/review/compare-capsules.mjs';
import { runProof } from '../src/proof/run-proof.mjs';
import { ProofError } from '../src/proof/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const modulePath = fileURLToPath(import.meta.url);

function scopedContext(scope, projectRoot, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const homedir = path.resolve(dependencies.homedir ?? os.homedir());
  const root = scope === 'project' ? path.resolve(projectRoot ?? dependencies.cwd ?? process.cwd()) : homedir;
  const registry = dependencies.hostRegistry
    ?? (dependencies.createHostRegistry ?? createHostRegistry)({ homedir, env });
  const targets = new Map([...registry].map(([host, adapter]) => {
    if (typeof adapter.resolveTarget !== 'function') throw new Error(`Host adapter ${host} cannot resolve scoped targets`);
    return [host, adapter.resolveTarget({ scope, projectRoot: root })];
  }));
  const detections = detectHosts({ env, homedir, registry, scope, projectRoot: root });
  return { env, homedir, root, registry, targets, detections };
}

function isInteractive(io) {
  return typeof io?.readLine === 'function' && io.isInteractive !== false;
}

function cancelled(message) {
  const error = new Error(message);
  error.exitCode = 130;
  return error;
}

async function requireScopedConfirmation(io, prompt, declineMessage) {
  const answer = await promptForScopedConfirmation(io, prompt);
  if (answer === null) throw cancelled('Operation cancelled at end of input.');
  if (!answer) throw new Error(declineMessage);
}

function formatScopedFailure(error) {
  const lines = [`Error: ${error.message}`];
  const reportedPaths = new Set();
  for (const detail of [...(error.rollbackErrors ?? []), ...(error.cleanupErrors ?? [])]) {
    const message = detail?.message ?? String(detail);
    const recoveryPath = detail?.recoveryPath;
    lines.push(`Recovery error: ${message}${recoveryPath ? ` (recovery data: ${recoveryPath})` : ''}`);
    if (recoveryPath) reportedPaths.add(recoveryPath);
  }
  for (const recoveryPath of error.recoveryPaths ?? []) {
    if (!reportedPaths.has(recoveryPath)) lines.push(`Recovery data retained at: ${recoveryPath}`);
  }
  return `${lines.join('\n')}\n`;
}

function quoteShellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function writeScopedNextSteps(io, plan) {
  const scopeArgs = plan.scope === 'project' ? `--scope project --project ${quoteShellArgument(plan.scopeRoot)}` : '--scope global';
  const agentArgs = plan.agents.map((agent) => `--agent ${agent}`).join(' ');
  const skillArgs = plan.selectedIds.length === listSkills(rootDir).length
    ? '--all'
    : plan.selectedIds.map((skill) => `--skill ${skill}`).join(' ');
  io.stdout.write(`Next: linmas doctor ${scopeArgs}\n`);
  io.stdout.write(`Next: linmas uninstall ${skillArgs} ${agentArgs} ${scopeArgs}\n`);
  io.stdout.write('Start a new session in the selected harness to refresh skill discovery.\n');
}

async function chooseScope(args, io, dependencies) {
  if (args.scope) return args.scope;
  if (!isInteractive(io)) throw new Error('Non-interactive install requires --scope project|global (or --project <path>).');
  const selected = await promptForScopedSelection(io, 'Choose installation scope:', [
    { value: 'project', label: `Project — ${path.resolve(args.projectPath ?? dependencies.cwd ?? process.cwd())}` },
    { value: 'global', label: `Global — ${path.resolve(dependencies.homedir ?? os.homedir())}` }
  ]);
  if (!selected?.length) throw cancelled('Install cancelled before writing files.');
  return selected[0];
}

async function runScopedInstall(args, io, dependencies) {
  const projectRoot = path.resolve(args.projectPath ?? dependencies.cwd ?? process.cwd());
  const env = dependencies.env ?? process.env;
  const homedir = path.resolve(dependencies.homedir ?? os.homedir());
  const registry = dependencies.hostRegistry
    ?? (dependencies.createHostRegistry ?? createHostRegistry)({ homedir, env });
  const skills = listSkills(rootDir);
  let selectedSkills;
  if (args.installAll) selectedSkills = skills;
  else if (args.skillNames?.length) selectedSkills = selectScopedSkills(skills, { skillNames: args.skillNames });
  else if (args.skillName) selectedSkills = selectScopedSkills(skills, { skillNames: [args.skillName] });
  else {
    if (!isInteractive(io)) throw new Error('Non-interactive install requires --skill <id> or --all.');
    const chosen = await promptForScopedSelection(io, 'Choose skills to install:', skills.map((skill) => ({
      value: skill.name, label: `${skill.name} — ${skill.description}`
    })), { allowAll: true, multiple: true });
    if (!chosen?.length) throw cancelled('Install cancelled before writing files.');
    selectedSkills = selectScopedSkills(skills, { skillNames: chosen });
  }

  let agents = args.agents ?? [];
  if (!agents.length) {
    if (!isInteractive(io)) throw new Error('Non-interactive install requires --agent claude|codex.');
    const chosen = await promptForScopedSelection(io, 'Choose host integrations:', [...registry].map(([host, adapter]) => {
      const projectTarget = adapter.resolveTarget({ scope: 'project', projectRoot });
      const globalTarget = adapter.resolveTarget({ scope: 'global', projectRoot });
      const projectStatus = adapter.detect({ env, scope: 'project', projectRoot }).status;
      const globalStatus = adapter.detect({ env, scope: 'global', projectRoot }).status;
      const label = host === 'claude' ? 'Claude Code' : host === 'codex' ? 'Codex' : host;
      return {
        value: host,
        label: `${label} — project ${projectStatus}: ${projectTarget.installRoot}; global ${globalStatus}: ${globalTarget.installRoot}`
      };
    }), { multiple: true });
    if (!chosen?.length) throw cancelled('Install cancelled before writing files.');
    agents = chosen;
  }
  agents = [...new Set(agents.map((agent) => agent === 'claude-code' ? 'claude' : agent))];

  const scope = await chooseScope(args, io, dependencies);
  const context = scopedContext(scope, projectRoot, { ...dependencies, hostRegistry: registry });
  const { root, targets } = context;
  for (const agent of agents) {
    const adapter = registry.get(agent);
    if (!adapter) throw new Error(`Unknown install agent: ${agent}`);
    const capability = adapter.validateTarget({ scope, projectRoot: root });
    if (!capability.writable) throw new Error(`${agent} target is not safely writable: ${capability.reason}`);
  }

  let method = args.method;
  if (!method) {
    if (!isInteractive(io)) throw new Error('Non-interactive install requires --method symlink|copy.');
    const chosen = await promptForScopedSelection(io, 'Choose installation method:', [
      { value: 'symlink', label: 'Symlink (recommended; shared durable copy)' },
      { value: 'copy', label: 'Copy (independent files at each destination)' }
    ]);
    if (!chosen?.length) throw cancelled('Install cancelled before writing files.');
    method = chosen[0];
  }

  const manifestPath = path.join(root, '.agents', 'linmas-manifest.json');
  const manifest = readScopedManifest(manifestPath, scope, LINMAS_VERSION);
  let plan = planScopedInstall({ skills: selectedSkills, agents, targets, scope, scopeRoot: root, manifest, method, dryRun: args.dryRun });
  io.stdout.write(formatScopedInstallPreview(plan));
  if (args.dryRun) return 0;
  if (plan.noOp) {
    io.stdout.write('Installation already matches the selected skills and targets.\n');
    return 0;
  }
  if (!isInteractive(io) && !args.assumeYes) throw new Error('Non-interactive install requires --yes after a complete preview.');

  let allowReplaceUnmanaged = false;
  let allowReplaceModified = false;
  const conflictKinds = new Set(plan.conflicts.map((conflict) => conflict.kind));
  if (conflictKinds.size && args.assumeYes) throw new Error('Unmanaged or modified content requires an interactive backup confirmation; --yes will not replace it.');
  if (conflictKinds.size && !isInteractive(io)) throw new Error('Conflicts require interactive confirmation; remove them or run an interactive install.');
  if (conflictKinds.has('unmanaged')) {
    await requireScopedConfirmation(io, 'Back up and replace unmanaged files?', 'Install cancelled; unmanaged files were preserved.');
    allowReplaceUnmanaged = true;
  }
  if (conflictKinds.has('modified')) {
    await requireScopedConfirmation(io, 'Back up and replace locally modified managed files?', 'Install cancelled; locally modified files were preserved.');
    allowReplaceModified = true;
  }
  if (!args.assumeYes) await requireScopedConfirmation(io, 'Install the previewed skills?', 'Install cancelled before writing files.');

  try {
    const result = applyScopedInstallPlan(plan, { allowReplaceUnmanaged, allowReplaceModified });
    io.stdout.write(result.status === 'NO_OP' ? 'Installation already matches the selected skills and targets.\n' : 'Install completed.\n');
    for (const backupPath of result.retainedBackups ?? []) io.stdout.write(`Backup retained at: ${backupPath}\n`);
    for (const warning of result.cleanupWarnings) io.stderr.write(`Warning: cleanup retained at ${warning.path}: ${warning.message}\n`);
    writeScopedNextSteps(io, plan);
    return 0;
  } catch (error) {
    const recoveryIncomplete = error.rollbackErrors?.length || error.cleanupErrors?.length || error.recoveryPaths?.length;
    if (error.code === 'LINMAS_SYMLINK_UNAVAILABLE' && !recoveryIncomplete && isInteractive(io) && !args.assumeYes) {
      io.stderr.write('Symlink creation is unavailable. Review and confirm a new copy plan.\n');
      const freshManifest = readScopedManifest(manifestPath, scope, LINMAS_VERSION);
      plan = planScopedInstall({ skills: selectedSkills, agents, targets, scope, scopeRoot: root, manifest: freshManifest, method: 'copy' });
      io.stdout.write(formatScopedInstallPreview(plan));
      if (plan.conflicts.length) throw new Error('The copy fallback has conflicts; no automatic fallback was applied.');
      await requireScopedConfirmation(io, 'Install the new copy preview?', 'Copy fallback cancelled; previous installation was restored.');
      const result = applyScopedInstallPlan(plan);
      io.stdout.write('Install completed using copy.\n');
      for (const backupPath of result.retainedBackups ?? []) io.stdout.write(`Backup retained at: ${backupPath}\n`);
      for (const warning of result.cleanupWarnings) io.stderr.write(`Warning: cleanup retained at ${warning.path}: ${warning.message}\n`);
      writeScopedNextSteps(io, plan);
      return 0;
    }
    if (error.installMethod === 'symlink' || error.code === 'LINMAS_SYMLINK_UNAVAILABLE') error.message += '; use --method copy.';
    throw error;
  }
}

async function runScopedUninstall(args, io, dependencies) {
  const scope = await chooseScope(args, io, dependencies);
  const projectRoot = path.resolve(args.projectPath ?? dependencies.cwd ?? process.cwd());
  const context = scopedContext(scope, projectRoot, dependencies);
  const { root, registry, targets } = context;
  const agents = args.agents?.length ? args.agents : isInteractive(io)
    ? await promptForScopedSelection(io, 'Choose host integrations to remove:', [
      { value: 'claude', label: `Claude — ${targets.get('claude').installRoot}` },
      { value: 'codex', label: `Codex — ${targets.get('codex').installRoot}` }
    ])
    : [];
  if (!agents?.length) throw cancelled('Uninstall cancelled before writing files.');
  for (const agent of agents) if (!registry.has(agent === 'claude-code' ? 'claude' : agent)) throw new Error(`Unknown uninstall agent: ${agent}`);
  const manifestPath = path.join(root, '.agents', 'linmas-manifest.json');
  const manifest = readScopedManifest(manifestPath, scope, LINMAS_VERSION);
  const skillNames = args.skillNames?.length ? args.skillNames : args.skillName ? [args.skillName] : [];
  const plan = planScopedUninstall({ manifest, targets, scope, scopeRoot: root, skillNames, agents, uninstallAll: args.installAll });
  io.stdout.write(formatScopedUninstallPreview(plan));
  if (args.dryRun) return 0;
  if (plan.noOp) {
    io.stdout.write('No managed files needed removal.\n');
    return 0;
  }
  if (!isInteractive(io) && !args.assumeYes) throw new Error('Non-interactive uninstall requires --yes after a complete preview.');
  if (!args.assumeYes) await requireScopedConfirmation(io, 'Remove the previewed managed attachments?', 'Uninstall cancelled; files were preserved.');
  const result = applyScopedUninstallPlan(plan);
  io.stdout.write(result.status === 'NO_OP' ? 'No managed files needed removal.\n' : 'Uninstall completed.\n');
  for (const backupPath of result.retainedBackups ?? []) io.stdout.write(`Backup retained at: ${backupPath}\n`);
  for (const warning of result.cleanupWarnings ?? []) io.stderr.write(`Warning: backup retained at ${warning.path}: ${warning.message}\n`);
  return 0;
}

function runScopedDoctor(args, io, dependencies) {
  const scope = args.scope;
  const projectRoot = path.resolve(args.projectPath ?? dependencies.cwd ?? process.cwd());
  const { root, targets, env, homedir } = scopedContext(scope, projectRoot, dependencies);
  const manifestPath = path.join(root, '.agents', 'linmas-manifest.json');
  const manifest = readScopedManifest(manifestPath, scope, LINMAS_VERSION);
  const legacyRoots = scope === 'project'
    ? [path.join(root, '.claude', 'skills'), path.join(root, '.codex', 'skills')]
    : [path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude'), 'skills'), path.join(env.CODEX_HOME || path.join(homedir, '.codex'), 'skills')];
  io.stdout.write(formatScopedDoctorReport({ manifest, targets, scope, scopeRoot: root, legacyRoots }));
  return 0;
}

export async function run(argv, io = process, dependencies = {}) {
  let args;
  try {
    args = parseArgv(argv);
  } catch (error) {
    io.stderr.write(`Error: ${error.message}\n`);
    return 2;
  }
  let hostRegistry;
  const env = dependencies.env ?? process.env;
  const homedir = path.resolve(dependencies.homedir ?? os.homedir());
  const getDetections = (options = {}) => detectHosts({
    env,
    homedir,
    registry: hostRegistry ||= dependencies.hostRegistry || (dependencies.createHostRegistry ?? createHostRegistry)({ homedir, env }),
    ...options
  });

  if (args.command === 'list') {
    const skills = listSkills(rootDir);
    io.stdout.write('Available Linmas skills:\n');
    for (const skill of skills) {
      io.stdout.write(`- ${skill.name} — ${skill.description}\n`);
    }
    return 0;
  }

  if (args.command === 'detect') {
    const detections = getDetections();
    for (const detection of detections) {
      io.stdout.write(`${detection.host}: ${detection.status}\n`);
      io.stdout.write(`  reason: ${detection.reason}\n`);
      io.stdout.write(`  target: ${detection.installRoot}\n`);
      io.stdout.write(`  writable: ${detection.writable}\n`);
    }
    return 0;
  }

  if (args.command === 'doctor' && args.scope) {
    try { return runScopedDoctor(args, io, dependencies); }
    catch (error) {
      io.stderr.write(`Error: ${error.message}\n`);
      return 1;
    }
  }

  if (args.command === 'doctor' || args.command === 'onboard') {
    const detections = getDetections();
    const manifests = [];
    const manifestErrors = [];
    for (const item of detections) {
      try {
        manifests.push(readManifest(item.manifestPath, item.host));
      } catch {
        manifestErrors.push({
          host: item.host,
          reason: 'manifest could not be parsed or validated'
        });
      }
    }

    if (args.command === 'doctor') {
      io.stdout.write(formatDoctorReport(detections, manifests, new Set(), manifestErrors));
      return manifestErrors.length > 0 ? 1 : 0;
    }

    const skills = listSkills(rootDir);
    const providerRegistry = dependencies.providerRegistry
      || (dependencies.createProviderRegistry ?? createProviderRegistry)();
    const capability = await inspectCodexCapability(providerRegistry);
    io.stdout.write(formatOnboarding(detections, skills, manifests, capability, manifestErrors));
    return 0;
  }

  if (args.command === 'review') {
    try {
      if (args.reviewAction === 'compare') {
        const delta = await loadAndCompareCapsules(args.compareBefore, args.compareAfter);
        io.stdout.write(formatSecurityDelta(delta, { output: args.output }));
        return 0;
      }
      const result = await runReview(args, {
        io,
        rootDir,
        providerRegistry: dependencies.providerRegistry || createProviderRegistry(),
        loadPolicy: loadPolicyPack
      });
      io.stdout.write(result.output);
      return result.exitCode;
    } catch (error) {
      io.stderr.write(`Error: ${error.message}\n`);
      return error instanceof ReviewError ? error.exitCode : 1;
    }
  }

  if (args.command === 'proof') {
    try {
      await runProof(args, { io });
      return 0;
    } catch (error) {
      io.stderr.write(`Error: ${error.message}\n`);
      return error instanceof ProofError ? error.exitCode : 1;
    }
  }

  if (args.command === 'install') {
    try {
      if (args.managedInstall) return await runScopedInstall(args, io, dependencies);
      const detections = getDetections();
      const skills = listSkills(rootDir);
      const manifests = detections.map((item) => readManifest(item.manifestPath, item.host));

      const selectedSkills = selectSkills(skills, args);

      const targetChoice = await promptForInstallTarget(io, detections);
      const selectedTargets = selectTargets(detections, targetChoice);

      const existingPaths = new Set();
      for (const target of selectedTargets) {
        for (const skill of selectedSkills) {
          const dest = path.join(target.installRoot, skill.name);
          if (fs.existsSync(dest)) {
            existingPaths.add(dest);
          }
        }
      }

      const timestamp = createTimestamp();
      const plan = planInstall({
        skills: selectedSkills,
        targets: selectedTargets,
        manifests,
        existingPaths,
        timestamp,
        dryRun: args.dryRun
      });

      io.stdout.write(formatInstallPreview(plan));
      if (args.dryRun) return 0;

      const hasManagedConflicts = plan.some((item) => item.existingState === 'managed');
      const hasUnmanagedConflicts = plan.some((item) => item.existingState === 'unmanaged');

      const { confirm, allowReplaceUnmanaged, allowReplaceManaged } = await promptForInstallConfirmation(
        io,
        { hasManagedConflicts, hasUnmanagedConflicts }
      );

      // Check if we attempted to replace conflict fields without permission
      if (hasManagedConflicts && !allowReplaceManaged) {
        throw new Error('Install aborted due to managed skill conflicts.');
      }
      if (hasUnmanagedConflicts && !allowReplaceUnmanaged) {
        throw new Error('Install aborted due to unmanaged conflicts.');
      }
      if (!confirm) {
        throw new Error('Install cancelled by user.');
      }

      const manifestMap = new Map(manifests.map((manifest) => [manifest.host, manifest]));
      const manifestPathByHost = new Map(detections.map((item) => [item.host, item.manifestPath]));
      applyInstallPlan(plan, manifestMap, manifestPathByHost);
      io.stdout.write(formatInstallSummary(plan));
      return 0;
    } catch (e) {
      io.stderr.write(args.managedInstall ? formatScopedFailure(e) : `Error: ${e.message}\n`);
      return e.exitCode === 130 ? 130 : 1;
    }
  }

  if (args.command === 'uninstall') {
    try {
      if (args.managedUninstall) return await runScopedUninstall(args, io, dependencies);
      const detections = getDetections();
      const manifests = detections.map((item) => readManifest(item.manifestPath, item.host));
      const fullPlan = planUninstall({
        manifests,
        detections,
        skillName: args.skillName,
        uninstallAll: args.installAll
      });

      const selectedHosts = await promptForUninstallTarget(io, fullPlan);
      const plan = fullPlan.filter((item) => selectedHosts.includes(item.host));

      io.stdout.write(formatUninstallPreview(plan));
      if (args.dryRun) return 0;

      const confirm = await promptForUninstallConfirmation(io);
      if (!confirm) {
        throw new Error('Uninstall cancelled by user.');
      }

      const manifestMap = new Map(manifests.map((manifest) => [manifest.host, manifest]));
      const manifestPathByHost = new Map(detections.map((item) => [item.host, item.manifestPath]));
      applyUninstallPlan(plan, manifestMap, manifestPathByHost);
      io.stdout.write('Uninstall completed.\n');
      return 0;
    } catch (e) {
      io.stderr.write(args.managedUninstall ? formatScopedFailure(e) : `Error: ${e.message}\n`);
      return e.exitCode === 130 ? 130 : 1;
    }
  }

  io.stderr.write(`Unknown command: ${args.command}\n`);
  return 1;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(modulePath);
  }
}

function createProcessIO(proc) {
  const rl = readline.createInterface({
    input: proc.stdin,
    crlfDelay: Infinity
  });
  const lines = rl[Symbol.asyncIterator]();
  let interrupted = false;
  rl.on('SIGINT', () => { interrupted = true; rl.close(); });

  return {
    ...proc,
    isInteractive: Boolean(proc.stdin.isTTY && proc.stdout.isTTY),
    allowPipedPrompts: true,
    async readLine() {
      const { value, done } = await lines.next();
      if (interrupted) throw cancelled('Operation cancelled by Ctrl-C.');
      return done ? null : value;
    },
    close() {
      rl.close();
    }
  };
}

if (isMainModule()) {
  const io = createProcessIO(process);
  const code = await run(process.argv, io);
  io.close();
  process.exit(code);
}
