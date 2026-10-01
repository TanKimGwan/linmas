import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture, cleanup, writePolicy, fileIdentity, getLinuxTools, linuxOnlyTest as test, runBoundary, inventory } from './helpers/irsa003-fixture.mjs';
import { pythonPhasePublication, waitForPhase } from './helpers/irsa003-phase.mjs';

function patchLauncher(f, transform) {
  fs.chmodSync(f.launcherPath,0o700);
  fs.writeFileSync(f.launcherPath,transform(fs.readFileSync(f.launcherPath,'utf8')));
  fs.chmodSync(f.launcherPath,0o500);
  f.policy.launcher=fileIdentity(f.launcherPath);writePolicy(f,f.policy);
}
function start(f) {
  const child=spawn(f.bootstrapPath,['--mode','clean'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  const completed=once(child,'exit');
  return {child,completed,output:()=>({stdout,stderr})};
}
function assertGone(pid) { assert(!fs.existsSync(`/proc/${pid}`),`descendant ${pid} remains`); }

test('cancellation at Git, archive, verifier and pre-acceptance gate reaps benign descendants', {timeout:90000}, async(t)=>{
  for(const phase of ['trusted Git HEAD','trusted snapshot archive','isolated trusted verifier','final-acceptance']) {
    for(const signal of ['SIGTERM','SIGINT','SIGHUP']) await t.test(`${phase} ${signal}`,async(childTest)=>{
      const f=createFixture('clean');childTest.after(()=>cleanup(f));
      const ready=path.join(f.root,'phase.json');
      const requestId=f.policy.request.id;
      const publication=pythonPhasePublication(ready,phase,requestId,'[os.getpid(),pid]');
      const benign=`import os,time,json,signal\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n time.sleep(60)\nelse:\n${publication.split('\n').map(line=>' '+line).join('\n')}\n time.sleep(60)\n`;
      patchLauncher(f,s=> {
        if(phase==='final-acceptance') return s.replace('    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR2})',`${pythonPhasePublication(ready,phase,requestId).split('\n').map(line=>'    '+line).join('\n')}\n    time.sleep(60)\n    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR2})`);
        return s.replace('    process = subprocess.Popen(args,',`    if label == ${JSON.stringify(phase)}:\n        args = [sys.executable, '-I', '-E', '-c', ${JSON.stringify(benign)}]\n    process = subprocess.Popen(args,`);
      });
      const run=start(f);childTest.after(()=>{if(run.child.exitCode===null)run.child.kill('SIGTERM');});
      const {pids}=await waitForPhase(ready,run.child,{phase,requestId,pidCount:phase==='final-acceptance'?0:2});
      run.child.kill(signal);
      const status=await Promise.race([run.completed,delay(8000).then(()=>{throw Error('cancellation unbounded');})]);
      const number={SIGHUP:1,SIGINT:2,SIGTERM:15}[signal];assert.equal(status[0],128+number,run.output().stderr);
      pids.forEach(assertGone);
      assert.deepEqual(fs.readdirSync(f.outputRoot),[]);
      assert.deepEqual(fs.readdirSync(f.temporaryRoot),[]);
    });
  }
});

test('bootstrap resets inherited signal mask/dispositions and closes descriptors above stderr', async(t)=>{
  const f=createFixture('clean');t.after(()=>cleanup(f));
  patchLauncher(f,()=>`import os,signal,json\nprint(json.dumps({'mask':[int(x) for x in signal.pthread_sigmask(signal.SIG_BLOCK,set())], 'termIgnored':signal.getsignal(signal.SIGTERM)==signal.SIG_IGN,'fd9Exists':os.path.exists('/proc/self/fd/9')}))\n`);
  const run=execFileSync(getLinuxTools().pythonPath,['-I','-E','-c',`import os,signal\nfd=os.open('/dev/null',os.O_RDONLY);os.dup2(fd,9,inheritable=True)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsignal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM,signal.SIGINT,signal.SIGHUP})\nos.execve(${JSON.stringify(f.bootstrapPath)},['bootstrap','--mode','clean'],{})`],{encoding:'utf8',timeout:5000});
  assert.deepEqual(JSON.parse(run),{mask:[],termIgnored:false,fd9Exists:false});
});

test('accepted final decision is not retroactively cancelled during protected IO',async(t)=>{
  const f=createFixture('clean');t.after(()=>cleanup(f));const ready=path.join(f.root,'final-granted');
  const publication=pythonPhasePublication(ready,'final-granted',f.policy.request.id);
  patchLauncher(f,s=>s.replace('    FINALIZING = True','    FINALIZING = True\n'+publication.split('\n').map(line=>'    '+line).join('\n')+'\n    time.sleep(0.4)'));
  const run=start(f);await waitForPhase(ready,run.child,{phase:'final-granted',requestId:f.policy.request.id,pidCount:0});run.child.kill('SIGTERM');
  assert.equal((await run.completed)[0],0,run.output().stderr);
  assert.equal(JSON.parse(run.output().stdout).consumption.result,'ACCEPTED');
  assert.equal(fs.readdirSync(f.outputRoot).filter(x=>x.endsWith('.consumed')).length,1);
});

test('streaming bounds, partial archive, child signal and namespace failure never accept',async(t)=>{
  for(const kind of ['archive-limit','verifier-limit','stderr-limit','timeout','invalid-archive','archive-link','partial-archive','child-signal','namespace-failure','fork-failure','exec-failure']) await t.test(kind,(sub)=>{
    const f=createFixture('clean');sub.after(()=>cleanup(f));
    if(kind==='fork-failure' || kind==='exec-failure') {
      let source=fs.readFileSync(path.join(f.root,'trusted-bootstrap.c'),'utf8');
      if(kind==='fork-failure')source=source.replace('long child = syscall0(SYS_FORK);','long child = -11;');
      else source=source.replace('#define LINMAS_PYTHON_PATH '+JSON.stringify(getLinuxTools().pythonPath),'#define LINMAS_PYTHON_PATH "/unavailable/fixture-python"');
      fs.writeFileSync(path.join(f.root,'failure-bootstrap.c'),source);
      fs.chmodSync(f.bootstrapPath,0o700);
      execFileSync('cc',['-nostdlib','-static','-fno-stack-protector','-fno-pie','-no-pie','-Wl,--build-id=none','-o',f.bootstrapPath,path.join(f.root,'failure-bootstrap.c')]);
      fs.chmodSync(f.bootstrapPath,0o500);f.policy.bootstrap=fileIdentity(f.bootstrapPath);writePolicy(f,f.policy);
    } else patchLauncher(f,s=>{
      if(kind==='namespace-failure')return s.replace('"--unshare-all", "--unshare-user",','"--userns", "9999", "--unshare-all", "--unshare-user",');
      const archive=kind.includes('archive');
      const label=archive?'trusted snapshot archive':'isolated trusted verifier';
      let script='';
      if(kind==='archive-limit')script="import os\nfor i in range(1100):os.write(1,b'x'*65536)";
      if(kind==='verifier-limit')script="import os\nfor i in range(160):os.write(1,b'x'*65536)";
      if(kind==='stderr-limit')script="import os\nfor i in range(160):os.write(2,b'x'*65536)";
      if(kind==='timeout')script="import time;time.sleep(60)";
      if(kind==='invalid-archive')script="import os;os.write(1,b'bad tar bytes')";
      if(kind==='partial-archive')script="import os;os.write(1,b'partial');os._exit(1)";
      if(kind==='archive-link')script="import tarfile,sys;t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|');m=tarfile.TarInfo('link');m.type=tarfile.SYMTYPE;m.linkname='/outside';t.addfile(m);t.close()";
      if(kind==='child-signal')script="import os,signal;os.kill(os.getpid(),signal.SIGTERM)";
      return s.replace('    process = subprocess.Popen(args,',`    if label == ${JSON.stringify(label)}:\n        args=[sys.executable,'-I','-E','-c',${JSON.stringify(script)}]\n        timeout=0.2 if ${JSON.stringify(kind)} == 'timeout' else timeout\n    process = subprocess.Popen(args,`);
    });
    const started=Date.now();
    const result=runBoundary(f);assert.notEqual(result.status,0,kind);
    if(['archive-limit','verifier-limit','stderr-limit'].includes(kind)) assert.match(result.stderr,/output exceeded the bounded limit/,kind);
    if(kind==='timeout') {assert.match(result.stderr,/bounded timeout/);assert(Date.now()-started<5000);}
    if(kind==='archive-link') assert.match(result.stderr,/unsupported entry/);
    if(kind==='partial-archive') assert.match(result.stderr,/trusted snapshot archive failed/);
    if(kind==='namespace-failure') assert.match(result.stderr,/bwrap/);
    assert.deepEqual(fs.readdirSync(f.outputRoot),[]);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot),[]);
  });
});

test('minimal worker denies unrelated synthetic host files in verifier and subprocess',t=>{
  const f=createFixture('collect');t.after(()=>cleanup(f));const sentinel=path.join(f.root,'private-synthetic');
  fs.writeFileSync(sentinel,'synthetic',{mode:0o600});
  const code=`import fs from 'node:fs';import cp from 'node:child_process';\nconst denied=${JSON.stringify([sentinel,f.policyPath,f.launcherPath,f.outputRoot,f.temporaryRoot])};\nfor(const item of denied) {if(fs.existsSync(item))throw Error('UNAUTHORIZED_MOUNT');}\nconst child=cp.spawnSync(process.execPath,['-e',\`const fs=require('fs');for(const p of \${JSON.stringify(denied)})if(fs.existsSync(p))throw Error('CHILD_UNAUTHORIZED_MOUNT');\`]);if(child.status!==0)throw Error('child scope');\nfs.writeFileSync(process.env.TMPDIR+'/scratch','works');\nprocess.stdout.write(JSON.stringify({disposition:{records:Array.from({length:23},(_,i)=>({recordId:'TRUSTED-'+i}))}}));`;
  fs.writeFileSync(path.join(f.verifierRoot,'collect.mjs'),code);f.policy.verifier.inventory=inventory(f.verifierRoot);writePolicy(f,f.policy);
  const r=runBoundary(f);assert.equal(r.status,0,r.stderr);
  const a=JSON.parse(fs.readFileSync(JSON.parse(r.stdout).output)).attestation;
  assert.equal(a.worker.observation.noNewPrivs,'1');
  assert(Object.values(a.worker.observation.capabilities).every(x=>/^0+$/.test(x)));
  assert.match(a.worker.observation.uidMap,/65534\s+0\s+1/);
  assert(a.worker.observation.readOnlyMounts.every(x=>x.source!=='/'));
  assert.equal(fs.readFileSync(sentinel,'utf8'),'synthetic');
});
