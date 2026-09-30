import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { repositoryRoot, createFixture, cleanup, runGit, writePolicy, runBoundary, sha256, inventory, getLinuxTools, linuxOnlyTest as test } from './helpers/irsa003-fixture.mjs';
import { buildContentIdentity, CLEAN_IDENTITY_PATH, GENERATED_EVIDENCE_PATHS, computeFreshEvidenceDigest } from '../scripts/validate-evidence-binding.mjs';
import { collectFreshEvidence } from '../scripts/evidence-operations.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// Copy the complete verifier-owned current identity scope, never a tiny
// success stub. Generated historical evidence is not part of that scope;
// the disposable repository gets its own HEAD, content identity, and fresh
// operation evidence below.
for (const instrumentBuilder of [false, true]) test(`actual full verifier consumes >8 MiB snapshot: ${instrumentBuilder ? 'builder confinement probe' : 'unchanged implementation'}`,  {timeout:120000}, async (t) => {
  const { nodePath } = getLinuxTools();
  const f = createFixture('clean');
  t.after(() => cleanup(f));
  const current = buildContentIdentity({repositoryRoot});
  const paths = current.includedFiles.map(x=>x.path);
  assert(paths.every(relative => !GENERATED_EVIDENCE_PATHS.includes(relative)));
  fs.rmSync(f.candidateRoot, {recursive:true});
  fs.rmSync(f.verifierRoot, {recursive:true});
  for(const root of [f.candidateRoot, f.verifierRoot]) {
    fs.mkdirSync(root, {mode:0o700});
    for(const relative of paths) {
      assert(!relative.split('/').some(x=>x.startsWith('.env') || x === '.local-agent'));
      const destination=path.join(root,relative);
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      fs.copyFileSync(path.join(repositoryRoot,relative),destination);
      fs.chmodSync(destination,fs.statSync(path.join(repositoryRoot,relative)).mode & 0o777);
    }
    for (const relative of GENERATED_EVIDENCE_PATHS) {
      assert.equal(fs.existsSync(path.join(root, relative)), false, `fixture must not import generated evidence: ${relative}`);
    }
  }
  const sentinel=path.join(f.root,'outside-authorized-inputs.txt');
  fs.writeFileSync(sentinel,'SYNTHETIC-CONFIDENTIAL-SENTINEL\n',{mode:0o600});
  // A benign assertion is inserted only into the disposable candidate builder.
  // Its real implementation still builds and verifies the real plugin bytes.
  const builder=path.join(f.candidateRoot,'scripts/build-codex-plugin.mjs');
  const guard=`\nif (process.env.TMPDIR?.startsWith('/run/linmas-worker')) {\n const probeFs = await import('node:fs');\n for (const denied of ${JSON.stringify([sentinel,f.policyPath,f.outputRoot,f.launcherPath])}) {\n  try { probeFs.accessSync(denied); throw new Error('UNAUTHORIZED_HOST_PATH_VISIBLE'); } catch(e) { if(e.message === 'UNAUTHORIZED_HOST_PATH_VISIBLE') throw e; }\n }\n const status = probeFs.readFileSync('/proc/self/status','utf8');\n if(!/^NoNewPrivs:\\s+1$/m.test(status) || !/^CapEff:\\s+0+$/m.test(status)) throw Error('BUILDER_AUTHORITY');\n const scratch=process.env.TMPDIR+'/builder-scratch-check';probeFs.writeFileSync(scratch,'ok');probeFs.unlinkSync(scratch);\n}\n`;
  const original=fs.readFileSync(builder,'utf8');
  if(instrumentBuilder) fs.writeFileSync(builder,original.replace('\n','\n'+guard));
  // Track the identity path before computing its self-excluding content digest.
  // The second fixture commit replaces this placeholder with the real identity;
  // its Git path classification therefore matches the final clean HEAD.
  writeJson(path.join(f.candidateRoot,CLEAN_IDENTITY_PATH),{fixturePlaceholder:true});
  runGit(f.candidateRoot,['init','-q']);
  runGit(f.candidateRoot,['add','-f','--',...paths,CLEAN_IDENTITY_PATH]);
  runGit(f.candidateRoot,['commit','-q','-m','complete current candidate fixture']);
  const identity=buildContentIdentity({repositoryRoot:f.candidateRoot});
  writeJson(path.join(f.candidateRoot,CLEAN_IDENTITY_PATH),identity);
  runGit(f.candidateRoot,['add','-f','--',CLEAN_IDENTITY_PATH]);
  runGit(f.candidateRoot,['commit','-q','-m','fixture generated identity']);
  const commit=runGit(f.candidateRoot,['rev-parse','HEAD']);
  const tree=runGit(f.candidateRoot,['rev-parse','HEAD^{tree}']);
  assert.equal(runGit(f.candidateRoot,['status','--porcelain=v1','--untracked-files=all']),'');
  const archiveBytes=execFileSync('/usr/bin/git',['archive','--format=tar',commit],{cwd:f.candidateRoot,maxBuffer:64*1024*1024}).length;
  assert(archiveBytes>8*1024*1024,'fixture must exceed the audited cap without padding or scope reduction');
  const npmExecPath=process.env.npm_execpath;
  assert.equal(typeof npmExecPath,'string','integration fixture requires the active npm_execpath');
  assert.notEqual(npmExecPath.trim(),'','npm_execpath must not be empty');
  assert.equal(path.isAbsolute(npmExecPath),true,'npm_execpath must be absolute');
  assert.equal(fs.statSync(npmExecPath).isFile(),true,'npm_execpath must resolve to a regular file');
  const npmCliSource=fs.realpathSync(npmExecPath);
  const npmCliStat=fs.lstatSync(npmCliSource);
  assert.equal(npmCliStat.isFile(),true,'resolved npm_execpath must be a regular file');
  assert.equal(npmCliStat.isSymbolicLink(),false,'resolved npm_execpath must not be a symlink');
  const npmSource=path.resolve(path.dirname(npmCliSource),'..');
  assert.equal(JSON.parse(fs.readFileSync(path.join(npmSource,'package.json'),'utf8')).name,'npm','active npm CLI must belong to the npm package');
  fs.rmSync(f.npmRoot,{recursive:true});
  execFileSync('/usr/bin/python3', ['-I','-E','-c','import shutil,sys;shutil.copytree(sys.argv[1],sys.argv[2],symlinks=False)',npmSource,f.npmRoot]);
  const npmOwnerUid=fs.lstatSync(f.root).uid;
  const npmDirectories=[f.npmRoot];
  while(npmDirectories.length>0) {
    const directory=npmDirectories.pop();
    const before=fs.lstatSync(directory);
    assert.equal(before.isDirectory(),true,'fixture-owned npm directory must be a directory');
    assert.equal(before.isSymbolicLink(),false,'fixture-owned npm directory must not be a symlink');
    assert.equal(before.uid,npmOwnerUid,'fixture-owned npm directory must belong to the fixture owner');
    fs.chmodSync(directory,0o700);
    const secured=fs.lstatSync(directory);
    assert.equal(secured.isDirectory(),true,'secured npm directory must remain a directory');
    assert.equal(secured.isSymbolicLink(),false,'secured npm directory must not be a symlink');
    assert.equal(secured.uid,npmOwnerUid,'secured npm directory must retain the fixture owner');
    assert.equal(secured.mode & 0o7777,0o700,'fixture-owned npm directory must be owner-private');
    assert.equal(secured.mode & 0o022,0,'fixture-owned npm directory must not permit group/world writes');
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      assert.equal(entry.isSymbolicLink(),false,'copied npm implementation must not contain symlinks');
      if(entry.isDirectory()) npmDirectories.push(path.join(directory,entry.name));
    }
  }
  const npmCli=path.join(f.npmRoot,'bin/npm-cli.js');
  fs.rmSync(f.artifactRoot,{recursive:true});fs.mkdirSync(path.join(f.artifactRoot,'plugin'),{recursive:true});
  const env={PATH:'/usr/bin:/bin',HOME:f.temporaryRoot,TMPDIR:f.temporaryRoot,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',LINMAS_APPROVED_NODE_PATH:nodePath,LINMAS_APPROVED_NPM_CLI:npmCli};
  execFileSync(nodePath,[npmCli,'pack','--ignore-scripts','--silent','--cache',path.join(f.temporaryRoot,'npm-cache'),'--pack-destination',f.artifactRoot],{cwd:f.candidateRoot,env,stdio:'pipe',timeout:30000});
  execFileSync(nodePath,[builder,'--target',path.join(f.artifactRoot,'plugin/linmas')],{cwd:f.candidateRoot,env,stdio:'pipe',timeout:30000});
  const beforeNpm=process.env.LINMAS_APPROVED_NPM_CLI;
  process.env.LINMAS_APPROVED_NPM_CLI=npmCli;
  let collected;
  try { collected=collectFreshEvidence({repositoryRoot:f.candidateRoot,artifactRoot:f.artifactRoot,packagePath:'linmas-0.9.0.tgz',pluginPath:'plugin/linmas'}); }
  finally { if(beforeNpm===undefined) delete process.env.LINMAS_APPROVED_NPM_CLI; else process.env.LINMAS_APPROVED_NPM_CLI=beforeNpm; }
  collected.disposition.contentIdentityDigest=identity.contentDigest;
  collected.disposition.evidenceDigest=computeFreshEvidenceDigest(collected.disposition);
  fs.chmodSync(f.acceptancePath,0o600);
  writeJson(f.acceptancePath,{schemaVersion:1,bindingKind:'clean-candidate-evidence',status:'UNRELEASED',packageVersion:'0.9.0',implementationHead:commit,workingTreeState:'clean',contentIdentity:{path:CLEAN_IDENTITY_PATH,sha256:sha256(fs.readFileSync(path.join(f.candidateRoot,CLEAN_IDENTITY_PATH))),contentDigest:identity.contentDigest},artifactBinding:collected.artifactBinding,evidenceDisposition:collected.disposition});
  fs.chmodSync(f.acceptancePath,0o400);
  f.policy.authorizedRevision={commit,tree};
  f.policy.request.acceptance.sha256=sha256(fs.readFileSync(f.acceptancePath));
  f.policy.npm={inventory:inventory(f.npmRoot),cliPath:npmCli,version:JSON.parse(fs.readFileSync(path.join(f.npmRoot,'package.json'))).version};
  f.policy.verifier={inventory:inventory(f.verifierRoot),collectEntrypoint:path.join(f.verifierRoot,'scripts/evidence-operations.mjs'),cleanEntrypoint:path.join(f.verifierRoot,'scripts/validate-evidence-binding.mjs')};
  writePolicy(f,f.policy);
  const result=runBoundary(f);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  const payload=JSON.parse(fs.readFileSync(output.output));
  assert.equal(output.consumption.result,'ACCEPTED');
  assert.equal(payload.attestation.executionSnapshot.archive.bytes,archiveBytes);
  assert.equal(payload.attestation.result.contentDigest,identity.contentDigest);
  assert.equal(payload.attestation.result.implementationHead,commit);
  assert.equal(payload.attestation.bindings.evidence.records.length,23);
  assert.equal(fs.readdirSync(f.outputRoot).filter(x=>x.endsWith('.consumed')).length,1);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'SYNTHETIC-CONFIDENTIAL-SENTINEL\n');
  assert.deepEqual(fs.readdirSync(f.temporaryRoot).filter(x=>x.startsWith('linmas-irsa003-')),[]);
  assert.equal(runBoundary(f,'consume').status,1);
  // Operator-owned fixture repair only: race two real consumers on same output.
  const marker=path.join(f.outputRoot,f.policy.request.id+'.consumed');fs.unlinkSync(marker);
  const run=async()=>{const child=spawn(f.bootstrapPath,['--mode','consume'],{stdio:'ignore'});return (await once(child,'exit'))[0];};
  const race=await Promise.all([run(),run()]);assert.deepEqual(race.sort(),[0,1]);
  fs.unlinkSync(marker);fs.mkdirSync(marker);
  assert.equal(runBoundary(f,'consume').status,1);
  fs.rmdirSync(marker);assert.equal(runBoundary(f,'consume').status,0);
  const summary={kind:'actual-independent-verifier-clean-fixture',candidateCommit:commit,candidateTree:tree,archiveBytes,contentDigest:identity.contentDigest,artifactBinding:collected.artifactBinding,verifier:f.policy.verifier.inventory,policySha256:sha256(fs.readFileSync(f.policyPath)),outputSha256:sha256(fs.readFileSync(output.output)),worker:payload.attestation.worker,race,exitStatus:result.status,consumption:output.consumption,invocation:[f.bootstrapPath,'--mode','clean'],candidateBuilder:instrumentBuilder ? 'actual implementation with benign confinement assertions in disposable fixture only' : 'unchanged current implementation'};
  if(process.env.LINMAS_TEST_EVIDENCE_DIR) {
    const evidenceBase=path.resolve(process.env.LINMAS_TEST_EVIDENCE_DIR);
    assert(evidenceBase.startsWith('/tmp/'));
    fs.mkdirSync(evidenceBase,{recursive:true});
    const kind=instrumentBuilder ? 'builder-confinement' : 'unchanged-implementation';
    const evidenceRoot=fs.mkdtempSync(path.join(evidenceBase,kind+'-'));
    writeJson(path.join(evidenceBase,'latest-'+kind+'.json'),{path:evidenceRoot});
    writeJson(path.join(evidenceRoot,'actual-clean-integration.json'),summary);
    fs.copyFileSync(output.output,path.join(evidenceRoot,'clean-attestation.json'));
    fs.copyFileSync(marker,path.join(evidenceRoot,'consumed.json'));
    fs.copyFileSync(f.policyPath,path.join(evidenceRoot,'fixture-policy.json'));
  }
});
