// tests/install-planning.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSkills, selectTargets, planInstall, promptForInstallChoices } from '../src/core/install-skills.mjs';

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

  assert.deepEqual(result, { targetChoice: 'both', confirm: false });
});

