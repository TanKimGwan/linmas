import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSkills, selectTargets, planInstall, promptForInstallChoices, promptForInstallConfirmation, promptForInstallTarget } from '../src/core/install-skills.mjs';

test('planInstall marks an unmanaged destination for backup before replace', () => {
  const plan = planInstall({
    skills: [{ name: 'secure-code-reviewer', description: 'desc', sourceDir: '/repo/skills/secure-code-reviewer', skillFile: '/repo/skills/secure-code-reviewer/SKILL.md' }],
    targets: [{ host: 'claude', status: 'detected', reason: 'ok', rootPath: '/tmp/.claude', installRoot: '/tmp/.claude/skills', manifestPath: '/tmp/.claude/linmas-manifest.json', writable: true }],
    manifests: [{ tool: 'linmas', version: '0.1.0', manifestVersion: 1, host: 'claude', installedAt: '2026-07-07T00:00:00.000Z', skills: [] }],
    existingPaths: new Set(['/tmp/.claude/skills/secure-code-reviewer']),
    timestamp: '20260707-120000',
    dryRun: true
  });

  assert.equal(plan[0].existingState, 'unmanaged');
  assert.match(plan[0].backupDir, /\.linmas-backups/);
  assert.equal(plan[0].willWrite, false);
});

test('selectSkills filters correct skills', () => {
  const skills = [
    { name: 'skill-a' },
    { name: 'skill-b' }
  ];
  assert.deepEqual(selectSkills(skills, { skillName: null, installAll: true }), skills);
  assert.deepEqual(selectSkills(skills, { skillName: 'skill-a', installAll: false }), [{ name: 'skill-a' }]);
  assert.throws(() => selectSkills(skills, { skillName: null, installAll: false }), /install requires a skill name or --all/);
  assert.throws(() => selectSkills(skills, { skillName: 'invalid', installAll: false }), /unknown skill: invalid/);
});

test('selectTargets returns only detected hosts', () => {
  const detections = [
    { host: 'claude', status: 'detected' },
    { host: 'codex', status: 'probably_detected' }
  ];
  assert.deepEqual(selectTargets(detections, 'both'), [{ host: 'claude', status: 'detected' }]);
  assert.deepEqual(selectTargets(detections, 'claude'), [{ host: 'claude', status: 'detected' }]);
  assert.throws(() => selectTargets([], 'both'), /No writable target hosts detected. Install aborted./);
  assert.throws(() => selectTargets([{ host: 'claude', status: 'not_detected' }], 'both'), /No writable target hosts detected. Install aborted./);
  assert.throws(() => selectTargets(detections, 'codex'), /Target host codex not detected or not writable./);
  assert.throws(() => selectTargets(detections, 'invalid_host'), /Target host invalid_host not detected or not writable./);
});

test('promptForInstallChoices exposes a non-interactive default choice helper', async () => {
  const result = await promptForInstallChoices({}, [
    { host: 'claude', status: 'detected' },
    { host: 'codex', status: 'detected' }
  ], [{ name: 'secure-code-reviewer' }]);

  assert.deepEqual(result, { targetChoice: 'both', confirm: false, allowReplaceUnmanaged: false, allowReplaceManaged: false });
});

function createPromptIO(inputs) {
  let stdoutData = '';
  let stderrData = '';
  const queue = [...inputs];
  return {
    stdout: {
      write(chunk) {
        stdoutData += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderrData += chunk;
        return true;
      }
    },
    getStdout() {
      return stdoutData;
    },
    getStderr() {
      return stderrData;
    },
    async readLine() {
      return queue.shift() || '';
    }
  };
}

test('promptForInstallChoices handles interactive selections and conflicts', async () => {
  const io = createPromptIO(['2', 'replace', 'yes']);
  const detections = [
    { host: 'claude', status: 'detected' },
    { host: 'codex', status: 'detected' }
  ];
  const result = await promptForInstallChoices(io, detections, [{ name: 'secure-code-reviewer' }], {
    hasManagedConflicts: false,
    hasUnmanagedConflicts: true
  });
  assert.deepEqual(result, {
    targetChoice: 'codex',
    confirm: true,
    allowReplaceUnmanaged: true,
    allowReplaceManaged: false
  });
});

test('promptForInstallTarget only prompts when multiple detected', async () => {
  const io = createPromptIO(['2']);
  const detections = [
    { host: 'claude', status: 'detected' },
    { host: 'codex', status: 'detected' }
  ];
  const target = await promptForInstallTarget(io, detections);
  assert.equal(target, 'codex');

  const ioSingle = createPromptIO([]);
  const targetSingle = await promptForInstallTarget(ioSingle, [
    { host: 'claude', status: 'detected' }
  ]);
  assert.equal(targetSingle, 'claude');
});

test('promptForInstallConfirmation prompts for conflicts and confirm', async () => {
  const io = createPromptIO(['replace', 'yes']);
  const result = await promptForInstallConfirmation(io, {
    hasManagedConflicts: true,
    hasUnmanagedConflicts: false
  });
  assert.deepEqual(result, {
    confirm: true,
    allowReplaceManaged: true,
    allowReplaceUnmanaged: false
  });
});

test('promptForInstallConfirmation skips final confirm when managed replacement is declined', async () => {
  const io = createPromptIO(['cancel']);
  const result = await promptForInstallConfirmation(io, {
    hasManagedConflicts: true,
    hasUnmanagedConflicts: false
  });
  assert.deepEqual(result, {
    confirm: false,
    allowReplaceManaged: false,
    allowReplaceUnmanaged: false
  });
  assert.doesNotMatch(io.getStdout(), /Confirm installation\? \[yes\/no\]/);
});

test('promptForInstallConfirmation skips final confirm when unmanaged replacement is declined', async () => {
  const io = createPromptIO(['cancel']);
  const result = await promptForInstallConfirmation(io, {
    hasManagedConflicts: false,
    hasUnmanagedConflicts: true
  });
  assert.deepEqual(result, {
    confirm: false,
    allowReplaceManaged: false,
    allowReplaceUnmanaged: false
  });
  assert.doesNotMatch(io.getStdout(), /Confirm installation\? \[yes\/no\]/);
});

test('install helpers export both interactive prompts and summary support', async () => {
  const module = await import('../src/core/install-skills.mjs');
  assert.equal(typeof module.promptForInstallTarget, 'function');
  assert.equal(typeof module.promptForInstallConfirmation, 'function');
  assert.equal(typeof module.promptForInstallChoices, 'function');
  assert.equal(typeof module.formatInstallSummary, 'function');
});
