import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NON_LINUX_SKIP_REASON = 'requires Linux bubblewrap sandbox';
let cachedLinuxTools;

function linuxOnlyTest(name, optionsOrFn, maybeFn) {
  if (process.platform === 'linux') {
    return typeof optionsOrFn === 'function'
      ? test(name, optionsOrFn)
      : test(name, optionsOrFn, maybeFn);
  }
  const callback = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const options = typeof optionsOrFn === 'function'
    ? { skip: NON_LINUX_SKIP_REASON }
    : { ...optionsOrFn, skip: NON_LINUX_SKIP_REASON };
  return test.skip(name, options, callback);
}

function getLinuxTools() {
  if (process.platform !== 'linux') throw new Error(NON_LINUX_SKIP_REASON);
  if (cachedLinuxTools) return cachedLinuxTools;
  const pythonPath = fs.realpathSync('/usr/bin/python3');
  const nodePath = fs.realpathSync(process.execPath);
  const gitCommand = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bwrapCommand = execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim();
  if (!gitCommand || !bwrapCommand) throw new Error('Linux IRSA sandbox dependencies are unavailable');
  const gitPath = fs.realpathSync(gitCommand);
  const bwrapPath = fs.realpathSync(bwrapCommand);
  cachedLinuxTools = Object.freeze({ pythonPath, nodePath, gitPath, bwrapPath });
  return cachedLinuxTools;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function mode(filePath) {
  return (fs.lstatSync(filePath).mode & 0o7777).toString(8).padStart(4, '0');
}

function fileIdentity(filePath, version) {
  const item = fs.lstatSync(filePath);
  const identity = {
    path: fs.realpathSync(filePath),
    bytes: item.size,
    sha256: sha256(fs.readFileSync(filePath)),
    ownerUid: item.uid,
    mode: mode(filePath)
  };
  if (version !== undefined) identity.version = version;
  return identity;
}

function inventory(root) {
  const files = [];
  function visit(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      assert.equal(entry.isSymbolicLink(), false, child);
      if (entry.isDirectory()) visit(child, childRelative);
      else {
        assert.equal(entry.isFile(), true);
        const bytes = fs.readFileSync(child);
        files.push({ path: childRelative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  visit(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    root: path.resolve(root),
    ownerUid: fs.lstatSync(root).uid,
    fileCount: files.length,
    implementationSha256: sha256(Buffer.from(canonicalJson({ schemaVersion: 1, files }))),
    files
  };
}

function commandVersion(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } }).trim();
}

function writePolicy(fixture, policy) {
  if (fs.existsSync(fixture.policyPath)) fs.chmodSync(fixture.policyPath, 0o600);
  fs.writeFileSync(fixture.policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  fs.chmodSync(fixture.policyPath, 0o400);
}

function runGit(cwd, args) {
  const { gitPath } = getLinuxTools();
  return execFileSync(gitPath, args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Linmas Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Linmas Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
    }
  }).trim();
}

function createFixture(modeName = 'clean') {
  const { pythonPath, nodePath, gitPath, bwrapPath } = getLinuxTools();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linmas-irsa003-outer-v2-'));
  fs.chmodSync(root, 0o700);
  const candidateRoot = path.join(root, 'candidate');
  const artifactRoot = path.join(root, 'artifacts');
  const temporaryRoot = path.join(root, 'temporary');
  const outputRoot = path.join(root, 'output');
  const verifierRoot = path.join(root, 'trusted-verifier');
  const npmRoot = path.join(root, 'trusted-npm');
  for (const directory of [candidateRoot, artifactRoot, temporaryRoot, outputRoot, verifierRoot, npmRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(path.join(candidateRoot, 'scripts'));
  fs.mkdirSync(path.join(candidateRoot, 'compatibility/evidence'), { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, 'package.json'), '{"name":"linmas","version":"0.9.0"}\n');
  fs.writeFileSync(path.join(candidateRoot, 'README.md'), 'authorized candidate\n');
  fs.writeFileSync(path.join(candidateRoot, 'scripts/evidence-operations.mjs'), `process.stdout.write(JSON.stringify({disposition:{records:Array.from({length:23},(_,i)=>({recordId:\`FABRICATED-\${i}\`}))}}));\n`);
  fs.writeFileSync(path.join(candidateRoot, 'scripts/validate-evidence-binding.mjs'), 'process.stdout.write(JSON.stringify({valid:true}));\n');
  fs.writeFileSync(path.join(candidateRoot, 'compatibility/evidence/v0.9.0-content-identity.json'), '{"contentDigest":"trusted-fixture"}\n');
  runGit(candidateRoot, ['init', '-q']);
  runGit(candidateRoot, ['add', '.']);
  runGit(candidateRoot, ['commit', '-q', '-m', 'authorized fixture']);
  const commit = runGit(candidateRoot, ['rev-parse', 'HEAD']);
  const tree = runGit(candidateRoot, ['rev-parse', 'HEAD^{tree}']);

  const records = Array.from({ length: 23 }, (_, index) => ({ recordId: `TRUSTED-${String(index).padStart(2, '0')}` }));
  const protectedTargets = [candidateRoot, artifactRoot, outputRoot, verifierRoot];
  fs.writeFileSync(path.join(verifierRoot, 'collect.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const writeDenied = {};
    for (const target of ${JSON.stringify(protectedTargets)}) {
      try {
        fs.writeFileSync(path.join(target, 'worker-write-probe'), 'unexpected');
        writeDenied[target] = false;
      } catch {
        writeDenied[target] = true;
      }
    }
    for (const [name, operation] of [
      ['chmod-candidate', () => fs.chmodSync(${JSON.stringify(path.join(candidateRoot, 'README.md'))}, 0o600)],
      ['rename-candidate', () => fs.renameSync(${JSON.stringify(path.join(candidateRoot, 'README.md'))}, ${JSON.stringify(path.join(candidateRoot, 'README.replaced'))})],
      ['replace-artifact', () => fs.writeFileSync(${JSON.stringify(path.join(artifactRoot, 'linmas-0.9.0.tgz'))}, 'replaced')]
    ]) {
      try {
        operation();
        writeDenied[name] = false;
      } catch {
        writeDenied[name] = true;
      }
    }
    process.stdout.write(JSON.stringify({disposition:{records:${JSON.stringify(records)}},writeDenied}));
  \n`);
  fs.writeFileSync(path.join(verifierRoot, 'clean.mjs'), `process.stdout.write(JSON.stringify({valid:true,implementationHead:${JSON.stringify(commit)},contentDigest:"trusted-fixture"}));\n`);

  fs.mkdirSync(path.join(npmRoot, 'bin'));
  fs.writeFileSync(path.join(npmRoot, 'package.json'), '{"name":"npm","version":"11.16.0"}\n');
  fs.writeFileSync(path.join(npmRoot, 'bin/npm-cli.js'), 'process.exit(0);\n');

  fs.mkdirSync(path.join(artifactRoot, 'plugin'));
  fs.writeFileSync(path.join(artifactRoot, 'linmas-0.9.0.tgz'), 'bounded package fixture\n');
  fs.writeFileSync(path.join(artifactRoot, 'plugin/package.json'), '{"name":"linmas","version":"0.9.0"}\n');

  const launcherPath = path.join(root, 'trusted-launch.py');
  const policyPath = path.join(root, 'trust-policy.json');
  const launcherSource = fs.readFileSync(path.join(repositoryRoot, 'scripts/irsa003-trusted-launch.py'), 'utf8');
  fs.writeFileSync(
    launcherPath,
    launcherSource.replace(
      'DEFAULT_TRUST_POLICY_PATH = "/etc/linmas/irsa003/trust-policy.json"',
      `DEFAULT_TRUST_POLICY_PATH = ${JSON.stringify(policyPath)}`
    ),
    { mode: 0o500 }
  );
  fs.chmodSync(launcherPath, 0o500);

  const bootstrapPath = path.join(root, 'trusted-bootstrap');
  let bootstrapSource = fs.readFileSync(path.join(repositoryRoot, 'scripts/irsa003-trusted-bootstrap.c'), 'utf8');
  bootstrapSource = bootstrapSource
    .replace('#define LINMAS_PYTHON_PATH "/usr/bin/python3"', `#define LINMAS_PYTHON_PATH ${JSON.stringify(pythonPath)}`)
    .replace('#define LINMAS_LAUNCHER_PATH "/usr/libexec/linmas/irsa003-trusted-launch.py"', `#define LINMAS_LAUNCHER_PATH ${JSON.stringify(launcherPath)}`);
  const bootstrapSourcePath = path.join(root, 'trusted-bootstrap.c');
  fs.writeFileSync(bootstrapSourcePath, bootstrapSource);
  execFileSync('cc', ['-nostdlib', '-static', '-fno-stack-protector', '-fno-pie', '-no-pie', '-Wl,--build-id=none', '-o', bootstrapPath, bootstrapSourcePath]);
  fs.chmodSync(bootstrapPath, 0o500);

  const acceptancePath = path.join(root, 'acceptance.json');
  const packageBytes = fs.readFileSync(path.join(artifactRoot, 'linmas-0.9.0.tgz'));
  const acceptance = {
    schemaVersion: 1,
    bindingKind: 'clean-candidate-evidence',
    status: 'UNRELEASED',
    packageVersion: '0.9.0',
    implementationHead: commit,
    workingTreeState: 'clean',
    contentIdentity: {
      path: 'compatibility/evidence/v0.9.0-content-identity.json',
      sha256: sha256(fs.readFileSync(path.join(candidateRoot, 'compatibility/evidence/v0.9.0-content-identity.json'))),
      contentDigest: 'trusted-fixture'
    },
    artifactBinding: {
      package: {
        path: 'linmas-0.9.0.tgz', filename: 'linmas-0.9.0.tgz', bytes: packageBytes.length,
        entryCount: 1, sha256: sha256(packageBytes), inventorySha256: 'a'.repeat(64),
        packageName: 'linmas', packageVersion: '0.9.0', published: false
      },
      plugin: {
        path: 'plugin', fileCount: 1, contentDigest: 'b'.repeat(64),
        packageName: 'linmas', packageVersion: '0.9.0', published: false
      }
    },
    evidenceDisposition: {
      mode: 'fresh', evidenceDigest: 'c'.repeat(64), recordIds: records.map((record) => record.recordId)
    }
  };
  fs.writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o400 });
  fs.chmodSync(acceptancePath, 0o400);

  const fixture = {
    root, candidateRoot, artifactRoot, temporaryRoot, outputRoot, verifierRoot,
    npmRoot, launcherPath, policyPath, bootstrapPath, acceptancePath, commit, tree
  };
  const now = Date.now();
  const requestId = `request-${crypto.randomUUID()}`;
  const policy = {
    schemaVersion: 2,
    workerRuntime: runtimeFiles(),
    policyId: 'fixture-outer-boundary-v2',
    trustOwnerUid: process.getuid(),
    workerUid: 65534,
    workerGid: 65534,
    candidateRoot,
    artifactRoot,
    temporaryRoot,
    outputRoot,
    timeoutSeconds: 120,
    request: {
      id: requestId,
      mode: modeName,
      notBefore: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
      acceptance: modeName === 'clean' ? { path: acceptancePath, sha256: sha256(fs.readFileSync(acceptancePath)) } : null
    },
    authorizedRevision: { commit, tree },
    bootstrap: fileIdentity(bootstrapPath),
    launcher: fileIdentity(launcherPath),
    python: fileIdentity(pythonPath, commandVersion(pythonPath, ['-I', '-E', '-c', 'import platform;print(platform.python_version())'])),
    node: fileIdentity(nodePath, commandVersion(nodePath, ['--version'])),
    git: fileIdentity(gitPath, commandVersion(gitPath, ['--version'])),
    bubblewrap: fileIdentity(bwrapPath, commandVersion(bwrapPath, ['--version'])),
    npm: { inventory: inventory(npmRoot), cliPath: path.join(npmRoot, 'bin/npm-cli.js'), version: '11.16.0' },
    verifier: {
      inventory: inventory(verifierRoot),
      collectEntrypoint: path.join(verifierRoot, 'collect.mjs'),
      cleanEntrypoint: path.join(verifierRoot, 'clean.mjs')
    }
  };
  fixture.policy = policy;
  writePolicy(fixture, policy);
  return fixture;
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function runBoundary(fixture, modeName = fixture.policy.request.mode, extraEnvironment = {}) {
  return spawnSync(fixture.bootstrapPath, ['--mode', modeName], {
    cwd: fixture.root,
    env: { PATH: '/usr/bin:/bin', HOME: fixture.root, ...extraEnvironment },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
}


let cachedRuntimeFiles;
function runtimeFiles() {
  if (cachedRuntimeFiles) return structuredClone(cachedRuntimeFiles);
  const { nodePath, gitPath } = getLinuxTools();
  const destinations = new Set();
  for (const executable of [nodePath, gitPath]) {
    const output = execFileSync('/usr/bin/ldd', [executable], {encoding:'utf8'});
    for (const match of output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)) destinations.add(match[1]);
  }
  cachedRuntimeFiles = [...destinations].sort().map(destination => ({destination, identity:fileIdentity(fs.realpathSync(destination))}));
  return structuredClone(cachedRuntimeFiles);
}
export { repositoryRoot, getLinuxTools, linuxOnlyTest, sha256, canonicalJson, fileIdentity, inventory, commandVersion, writePolicy, runGit, createFixture, cleanup, runBoundary, runtimeFiles };
