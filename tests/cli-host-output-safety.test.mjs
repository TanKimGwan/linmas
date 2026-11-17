import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../bin/linmas.mjs';
import { formatDoctorReport } from '../src/core/doctor.mjs';
import { formatOnboarding } from '../src/core/onboard.mjs';
import { formatInstallPreview, formatInstallSummary } from '../src/core/install-skills.mjs';
import { formatUninstallPreview } from '../src/core/uninstall-skills.mjs';
import { formatScopedInstallPreview, formatScopedUninstallPreview, promptForScopedSelection } from '../src/core/scoped-skills.mjs';

// T13 A: text output of list/detect/doctor/onboard/install/uninstall shows
// values that are not Linmas constants (host detection, manifests, skill
// metadata, paths, environment, capability results) through terminalSafe.
// Written with escapes so this file stays free of raw control characters.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const HOSTILE = 'x\u001b[2J\u202e\u0085';
const HOSTILE_SHOWN = 'x\\u001b[2J\\u202e\\u0085';
// A legitimate non-ASCII path must stay readable.
const NON_ASCII = 'Zo\u00eb \u6280\u80fd';

function unsafe(text) { return UNSAFE.test(text.replaceAll('\n', '')); }
function noForgedLines(text) { return !text.split('\n').some((line) => line.startsWith('Human review required') || line.startsWith('FORGED')); }

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `linmas-host-text-${NON_ASCII}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hostileRegistry(home) {
  const rootPath = path.join(home, `.fake${HOSTILE}`);
  const installRoot = path.join(rootPath, 'skills');
  const manifestPath = path.join(home, 'missing-manifest.json');
  const detection = { host: 'fake', status: 'detected', reason: `reason ${HOSTILE}\nFORGED line`, rootPath, installRoot, manifestPath, writable: true };
  return new Map([['fake', {
    detect() { return { ...detection }; },
    getInstallRoot() { return installRoot; },
    getManifestPath() { return manifestPath; },
    validateTarget() { return { status: 'detected', writable: true, reason: detection.reason }; }
  }]]);
}

function captureIo() {
  const io = { out: '', err: '' };
  io.stdout = { write(value) { io.out += value; return true; } };
  io.stderr = { write(value) { io.err += value; return true; } };
  return io;
}

test('T13 A detect, doctor and onboard print host values without raw control characters', async (t) => {
  const home = tempHome(t);
  const hostRegistry = hostileRegistry(home);
  const providerRegistry = new Map([['codex', {
    detectConfiguration() { return { status: 'configured', missingRequirements: [] }; },
    async discoverCapabilities() { return { authMode: 'not-required' }; }
  }]]);
  for (const command of ['detect', 'doctor', 'onboard']) {
    const io = captureIo();
    await run(['node', 'linmas', command], io, { hostRegistry, providerRegistry, homedir: home, env: {} });
    const text = io.out + io.err;
    assert.equal(unsafe(text), false, `${command}: ${JSON.stringify(text)}`);
    assert.equal(noForgedLines(text), true, `${command}: ${JSON.stringify(text)}`);
    assert.ok(text.includes(HOSTILE_SHOWN), `${command}: ${JSON.stringify(text)}`);
    if (command !== 'doctor') assert.ok(text.includes(NON_ASCII), `${command} keeps the non-ASCII path readable`);
  }
});

test('T13 A argument errors and unknown commands are printed safely', async () => {
  const unknownOption = captureIo();
  assert.equal(await run(['node', 'linmas', 'list', `--bad${HOSTILE}`], unknownOption), 2);
  assert.equal(unsafe(unknownOption.err), false, JSON.stringify(unknownOption.err));
  assert.ok(unknownOption.err.includes(HOSTILE_SHOWN));

  const unknownCommand = captureIo();
  assert.equal(await run(['node', 'linmas', `bogus${HOSTILE}`], unknownCommand), 1);
  assert.equal(unknownCommand.err, `Unknown command: bogus${HOSTILE_SHOWN}\n`);
});

test('T13 A host formatters escape manifest, skill, path and capability values', () => {
  const detection = { host: 'fake', status: 'detected', reason: `r${HOSTILE}`, rootPath: `/tmp/${NON_ASCII}`, installRoot: `/tmp/${NON_ASCII}/skills${HOSTILE}`, writable: true };
  const manifest = { host: 'fake', skills: [{ name: `skill${HOSTILE}\nFORGED`, path: `/nonexistent/${HOSTILE}` }] };
  const outputs = {
    doctor: formatDoctorReport([detection], [manifest], new Set(), [{ host: 'fake', reason: `bad${HOSTILE}` }]),
    onboard: formatOnboarding([detection], [{ name: 'linmas-x', description: `desc${HOSTILE}\nFORGED` }], [manifest], { status: 'BLOCKED', reason: `cap${HOSTILE}` }),
    installPreview: formatInstallPreview([{ host: 'fake', skill: { name: `s${HOSTILE}` }, destinationDir: `/tmp/${NON_ASCII}${HOSTILE}`, existingState: 'missing', backupDir: `/b${HOSTILE}`, willWrite: true }]),
    installSummary: formatInstallSummary([{ host: 'fake', skill: { name: `s${HOSTILE}`, description: `d${HOSTILE}\nFORGED` }, destinationDir: `/tmp/${NON_ASCII}${HOSTILE}`, willWrite: true }]),
    uninstallPreview: formatUninstallPreview([{ host: 'fake', skillName: `s${HOSTILE}`, skillPath: `/tmp/${NON_ASCII}${HOSTILE}` }]),
    scopedInstallPreview: formatScopedInstallPreview({
      scope: 'project', requestedMethod: 'copy', dryRun: true, conflicts: [],
      destinations: [{ id: `s${HOSTILE}`, sourceVersion: '1', canonicalPath: `/tmp/${NON_ASCII}${HOSTILE}`, attachments: [{ host: 'claude', method: 'copy', path: `/a${HOSTILE}` }] }],
      operations: [{ state: 'create', absolutePath: `/o${HOSTILE}`, backupAbsolutePath: `/bk${HOSTILE}` }],
      affected: [{ hosts: [`h${HOSTILE}`], skill: `s${HOSTILE}` }],
      retained: [{ skill: `s${HOSTILE}`, unknown: false, reference: `/r${HOSTILE}` }]
    }),
    scopedUninstallPreview: formatScopedUninstallPreview({ scope: 'project', operations: [{ host: 'claude', absolutePath: `/o${HOSTILE}` }], skipped: [{ skill: `s${HOSTILE}`, reason: `why${HOSTILE}`, path: `/p${HOSTILE}` }] })
  };
  for (const [name, text] of Object.entries(outputs)) {
    assert.equal(unsafe(text), false, `${name}: ${JSON.stringify(text)}`);
    assert.equal(noForgedLines(text), true, `${name}: ${JSON.stringify(text)}`);
    assert.ok(text.includes(HOSTILE_SHOWN), name);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), name);
  }
  for (const name of ['onboard', 'installPreview', 'installSummary', 'uninstallPreview', 'scopedInstallPreview']) assert.ok(outputs[name].includes(NON_ASCII), name);
});

test('T13 A scoped selection prompts escape option labels', async () => {
  let out = '';
  const io = { stdout: { write(value) { out += value; } }, async readLine() { return null; } };
  await promptForScopedSelection(io, `Choose${HOSTILE}:`, [{ value: 'a', label: `Project \u2014 /tmp/${NON_ASCII}${HOSTILE}\nFORGED` }]);
  assert.equal(unsafe(out), false, JSON.stringify(out));
  assert.equal(noForgedLines(out), true);
  assert.ok(out.includes(`Project \u2014 /tmp/${NON_ASCII}${HOSTILE_SHOWN}\\u000aFORGED`));
});

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('T13 round 2 list prints a skill description from SKILL.md without raw control characters', (t) => {
  // list reads skills next to the running CLI, so run a private copy whose
  // skill metadata carries hostile characters.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-list-copy-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const entry of ['bin', 'src', 'skills', 'package.json']) fs.cpSync(path.join(repositoryRoot, entry), path.join(copy, entry), { recursive: true });
  const skillFile = path.join(copy, 'skills', 'linmas-secure-code-reviewer', 'SKILL.md');
  const text = fs.readFileSync(skillFile, 'utf8');
  assert.match(text, /^description: /m);
  fs.writeFileSync(skillFile, text.replace(/^description: /m, `description: ${HOSTILE}`));
  const result = spawnSync(process.execPath, [path.join(copy, 'bin', 'linmas.mjs'), 'list'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(unsafe(result.stdout), false, JSON.stringify(result.stdout));
  assert.match(result.stdout, new RegExp(`- linmas-secure-code-reviewer \u2014 ${HOSTILE_SHOWN.replaceAll('\\', '\\\\').replaceAll('[', '\\[')}Secure code review`));
});

test('T13 round 2 install prints a retained backup path without raw control characters', { skip: process.platform === 'win32' }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-backup-text-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, `proj${HOSTILE}`);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const skill = 'linmas-secure-code-reviewer';
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
  // An unmanaged file at the destination is backed up after approval, and the
  // CLI reports the retained backup path, which lies under the project path.
  fs.writeFileSync(path.join(project, '.claude', 'skills', skill), 'foreign file\n');
  const answers = ['yes', 'yes'];
  const io = captureIo();
  io.isInteractive = true;
  io.readLine = async () => answers.shift() ?? null;
  assert.equal(await run(['node', 'linmas', 'install', '--skill', skill, '--agent', 'claude', '--method', 'copy', '--project', project], io, { homedir: home, env: {} }), 0, io.err);
  const line = io.out.split('\n').find((item) => item.startsWith('Backup retained at: '));
  assert.ok(line, io.out);
  assert.ok(line.startsWith(`Backup retained at: ${path.join(base, `proj${HOSTILE_SHOWN}`, '.agents', '.linmas-backups')}`), line);
  assert.equal(unsafe(io.out + io.err), false, JSON.stringify(io.out + io.err));
});
