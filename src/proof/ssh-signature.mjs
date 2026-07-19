import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProofError } from './errors.mjs';

const NAMESPACE = 'linmas-proof-v1';

export async function signManifest(manifestPath, privateKeyPath, { fsApi = fs, command = runProcess } = {}) {
  await assertPrivateKey(privateKeyPath, fsApi);
  await run(command, 'ssh-keygen', ['-Y', 'sign', '-n', NAMESPACE, '-f', privateKeyPath, manifestPath]);
  const signaturePath = `${manifestPath}.sig`;
  const signature = await fsApi.readFile(signaturePath);
  return { signaturePath, signature };
}

export async function derivePublicKey(privateKeyPath, { fsApi = fs, command = runProcess } = {}) {
  await assertPrivateKey(privateKeyPath, fsApi);
  const publicKey = await run(command, 'ssh-keygen', ['-y', '-f', privateKeyPath]);
  const publicKeyText = publicKey.stdout.trim();
  if (!publicKeyText) throw signerError('SSH public key derivation returned no key');
  return Buffer.from(`${publicKeyText}\n`);
}

export async function verifyManifestSignature({ manifestPath, signaturePath, publicKeyPath, allowedSignersPath = null, principal }, { fsApi = fs, command = runProcess } = {}) {
  const publicKey = await fsApi.readFile(publicKeyPath, 'utf8');
  const temporary = allowedSignersPath ? null : await fsApi.mkdtemp(path.join(os.tmpdir(), 'linmas-ssh-'));
  const verifierPath = allowedSignersPath ?? path.join(temporary, 'allowed-signers');
  if (!allowedSignersPath) await fsApi.writeFile(verifierPath, `${principal} ${publicKey.trim()}\n`, { mode: 0o600 });
  try {
    await run(command, 'ssh-keygen', ['-Y', 'verify', '-f', verifierPath, '-I', principal, '-n', NAMESPACE, '-s', signaturePath], { input: await fsApi.readFile(manifestPath) });
    return { signature: 'valid', identity: allowedSignersPath ? 'trusted' : 'self-asserted' };
  } catch (cause) {
    throw signerError('SSH manifest signature verification failed', cause);
  } finally {
    if (temporary) await fsApi.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function assertPrivateKey(target, fsApi) {
  let stat;
  try { stat = await fsApi.lstat(target); } catch (cause) { throw signerError('SSH signing key could not be inspected', cause); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw signerError('SSH signing key must be a regular non-symlink file');
}

async function run(command, file, args, options = {}) {
  try { return await command(file, args, { input: options.input }); }
  catch (cause) { throw signerError(`ssh-keygen command failed: ${cause.message}`, cause); }
}

function runProcess(file, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      else reject(Object.assign(new Error(Buffer.concat(stderr).toString('utf8').trim() || `exit code ${code}`), { code }));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function signerError(message, cause) { const error = new ProofError(message, 'signature', 4); if (cause) error.cause = cause; return error; }
