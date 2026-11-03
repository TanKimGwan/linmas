import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertInsideRoot } from './fs-utils.mjs';
import { createScopedManifest, validateScopedManifest } from './manifest.mjs';
import { assertSafeDestructiveFilesystem, openSafeMutationAnchors, removeSafeLeaf } from './uninstall-skills.mjs';
import { matchesSkillIdentifier } from './skill-catalog.mjs';
import { LINMAS_VERSION } from './version.mjs';

const WINDOWS_SAFE_FILESYSTEM_ERROR = 'SAFE_FILESYSTEM_OPERATION_UNAVAILABLE';

function lstatMaybe(filePath) {
  try { return fs.lstatSync(filePath, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function sameNode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function digestDirectory(directory) {
  const hash = createHash('sha256');
  function walk(current, prefix = '') {
    for (const name of fs.readdirSync(current).sort()) {
      const fullPath = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Skill payload contains a symlink: ${relative}`);
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        walk(fullPath, relative);
      } else if (stat.isFile()) {
        hash.update(`F\0${relative}\0${stat.mode & 0o111}\0`);
        hash.update(fs.readFileSync(fullPath));
        hash.update('\0');
      } else {
        throw new Error(`Skill payload contains a non-regular entry: ${relative}`);
      }
    }
  }
  walk(directory);
  return hash.digest('hex');
}

function ensureDirectory(directory) {
  const resolved = path.resolve(directory);
  const current = lstatMaybe(resolved);
  if (current) {
    if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`Unsafe directory: ${directory}`);
    const verify = openSafeMutationAnchors(resolved, resolved);
    verify.close();
    return;
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) throw new Error(`Unsafe directory: ${directory}`);
  ensureDirectory(parent);
  const parentAnchor = openSafeMutationAnchors(parent, parent);
  try {
    parentAnchor.assertCurrent();
    const child = path.join(parentAnchor.parentPath, path.basename(resolved));
    const stat = lstatMaybe(child);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory: ${directory}`);
    } else {
      fs.mkdirSync(child, { mode: 0o700 });
    }
  } finally {
    parentAnchor.close();
  }
  const verify = openSafeMutationAnchors(parent, resolved);
  verify.close();
}

function rootForKey(rootKey, targets, scopeRoot, rootOverride) {
  if (rootKey === 'agents') return path.join(scopeRoot, '.agents');
  const claude = targets.get('claude');
  if (!claude) throw new Error('Claude target is required to resolve a managed attachment');
  return rootOverride ? path.resolve(rootOverride) : claude.rootPath;
}

function absoluteEntry(rootKey, relativePath, targets, scopeRoot, rootOverride) {
  const root = rootForKey(rootKey, targets, scopeRoot, rootOverride);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  assertInsideRoot(root, path.dirname(absolute));
  return absolute;
}

function attachmentRoot(attachment, targets, scopeRoot, scope) {
  const override = scope === 'global' && attachment.host === 'claude' ? attachment.targetRoot : undefined;
  return rootForKey(attachment.root, targets, scopeRoot, override);
}

function absoluteAttachment(attachment, targets, scopeRoot, scope) {
  return absoluteEntry(attachment.root, attachment.path, targets, scopeRoot,
    scope === 'global' && attachment.host === 'claude' ? attachment.targetRoot : undefined);
}

function attachmentRootMismatch(attachment, targets, scope) {
  return scope === 'global' && attachment.host === 'claude'
    && path.resolve(attachment.targetRoot) !== path.resolve(targets.get('claude').rootPath);
}

function findForeignCanonicalReference(skill, canonicalPath, targets, scopeRoot, scope, journal = []) {
  const managedLinks = new Set(skill.attachments
    .filter((attachment) => attachment.method === 'symlink')
    .map((attachment) => absoluteAttachment(attachment, targets, scopeRoot, scope)));
  const transactionLinks = new Set();
  for (const entry of journal) {
    if (!entry.rollbackPath || !entry.rollbackIdentity) continue;
    const current = lstatMaybe(entry.rollbackPath);
    if (!current?.isSymbolicLink() || !sameNode(current, entry.rollbackIdentity)) continue;
    if (path.resolve(path.dirname(entry.rollbackPath), fs.readlinkSync(entry.rollbackPath)) === path.resolve(canonicalPath)) {
      transactionLinks.add(entry.rollbackPath);
    }
  }
  const knownRoots = new Set([targets.get('claude')?.installRoot]);
  for (const attachment of skill.attachments.filter((entry) => entry.host === 'claude')) {
    knownRoots.add(path.join(attachmentRoot(attachment, targets, scopeRoot, scope), 'skills'));
  }

  for (const root of knownRoots) {
    if (!root) continue;
    let rootStat;
    try { rootStat = lstatMaybe(root); }
    catch { return { path: root, unknown: true }; }
    if (!rootStat) continue;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { path: root, unknown: true };
    let names;
    try { names = fs.readdirSync(root); }
    catch { return { path: root, unknown: true }; }
    for (const name of names) {
      const candidate = path.join(root, name);
      const stat = lstatMaybe(candidate);
      if (!stat?.isSymbolicLink()) continue;
      const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
      if (target === path.resolve(canonicalPath) && !managedLinks.has(candidate) && !transactionLinks.has(candidate)) return { path: candidate };
    }
  }
  return null;
}

function previousAttachment(skill, host) {
  return skill?.attachments.find((attachment) => attachment.host === host) ?? null;
}

function consumesCanonical(attachment) {
  return attachment.host === 'codex' || attachment.method === 'symlink';
}

function stateOf(absolutePath, managedRecord, { linkTarget, linkBase } = {}) {
  const identity = lstatMaybe(absolutePath);
  if (!identity) return { state: 'missing', identity: null };
  if (!managedRecord) return { state: 'unmanaged', identity };
  if (identity.isSymbolicLink()) {
    if (managedRecord.method !== 'symlink' || !linkTarget) return { state: 'modified', identity };
    const actual = path.resolve(linkBase ?? path.dirname(absolutePath), fs.readlinkSync(absolutePath));
    return { state: actual === path.resolve(linkTarget) ? 'managed' : 'modified', identity };
  }
  if (!identity.isDirectory() || identity.isSymbolicLink()) return { state: 'modified', identity };
  try {
    return { state: digestDirectory(absolutePath) === managedRecord.sha256 ? 'managed' : 'modified', identity };
  } catch {
    return { state: 'modified', identity };
  }
}

function digestEntry(entryPath) {
  const hash = createHash('sha256');
  function walk(current, relative = '') {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${relative}\0${stat.mode & 0o777}\0${fs.readlinkSync(current)}\0`);
    } else if (stat.isDirectory()) {
      hash.update(`D\0${relative}\0${stat.mode & 0o777}\0`);
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      hash.update(`F\0${relative}\0${stat.mode & 0o777}\0`);
      hash.update(fs.readFileSync(current));
      hash.update('\0');
    } else {
      throw new Error(`Cannot back up non-regular entry: ${current}`);
    }
  }
  walk(entryPath);
  return hash.digest('hex');
}

function copyBackupEntry(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
  else fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
}

function createBackupReference(operation, { scope, skillId }) {
  const id = randomUUID();
  const root = operation.root ?? (operation.host === 'codex' ? 'agents' : 'claude');
  const reference = {
    id, skillId, host: operation.host, root, originalPath: operation.relativePath,
    backupPath: `.linmas-backups/${id}`, state: operation.state,
    entryKind: lstatMaybe(operation.absolutePath)?.isSymbolicLink() ? 'symlink'
      : lstatMaybe(operation.absolutePath)?.isDirectory() ? 'directory' : 'file',
    sha256: digestEntry(operation.absolutePath), createdAt: new Date().toISOString()
  };
  if (scope === 'global' && operation.host === 'claude') reference.targetRoot = operation.rootPath;
  return reference;
}

function normalizeAgents(agents) {
  const normalized = [...new Set((agents ?? []).map((agent) => agent === 'claude-code' ? 'claude' : agent))];
  if (normalized.some((agent) => !['claude', 'codex'].includes(agent))) throw new Error('Unknown install agent; choose claude or codex');
  if (!normalized.length) throw new Error('At least one install agent is required');
  return normalized;
}

export function selectScopedSkills(skills, { skillNames = [], installAll = false } = {}) {
  if (installAll) return skills;
  if (!skillNames.length) throw new Error('install requires a skill or --all');
  const selected = [];
  for (const name of skillNames) {
    const skill = skills.find((entry) => matchesSkillIdentifier(entry.name, name));
    if (!skill) throw new Error(`unknown skill: ${name}`);
    if (!selected.some((item) => item.name === skill.name)) selected.push(skill);
  }
  return selected;
}

export async function promptForScopedSelection(io, title, options, { allowAll = false, multiple = false } = {}) {
  if (!io || typeof io.readLine !== 'function') return null;
  while (true) {
    io.stdout.write(`${title}\n`);
    options.forEach((option, index) => io.stdout.write(`[${index + 1}] ${option.label}\n`));
    if (allowAll) io.stdout.write('[all] Choose every skill\n');
    io.stdout.write(`${multiple ? 'Enter comma-separated numbers' : 'Enter one number'}, or blank to cancel: `);
    const line = await io.readLine();
    if (line === null || !line.trim()) return null;
    if (allowAll && line.trim().toLowerCase() === 'all') return options.map((option) => option.value);
    const indices = line.split(',').map((part) => part.trim());
    if (!multiple && indices.length !== 1) {
      io.stdout.write('Choose one option only. Try again.\n');
      continue;
    }
    if (indices.some((index) => !/^\d+$/.test(index) || Number(index) < 1 || Number(index) > options.length)) {
      io.stdout.write('Invalid selection. Try again.\n');
      continue;
    }
    return [...new Set(indices.map((index) => options[Number(index) - 1].value))];
  }
}

export async function promptForScopedConfirmation(io, prompt) {
  if (!io || typeof io.readLine !== 'function') return false;
  io.stdout.write(`${prompt} [yes/no]\n`);
  const line = await io.readLine();
  if (line === null) return null;
  return line !== null && ['yes', 'y'].includes(line.trim().toLowerCase());
}

export function planScopedInstall({ skills, agents, targets, scope, scopeRoot, manifest, method, dryRun = false }) {
  if (!['project', 'global'].includes(scope)) throw new Error(`Invalid installation scope: ${scope}`);
  if (!['copy', 'symlink'].includes(method)) throw new Error(`Invalid installation method: ${method}`);
  validateScopedManifest(manifest, scope);
  const selectedAgents = normalizeAgents(agents);
  const claudeRoot = targets.get('claude')?.rootPath;
  if (scope === 'global' && selectedAgents.includes('claude') && claudeRoot
    && path.resolve(claudeRoot) === path.resolve(path.join(scopeRoot, '.agents'))) {
    throw new Error('Claude configuration root overlaps the canonical .agents directory');
  }
  const desired = [];
  const operations = [];
  const conflicts = [];
  const affected = [];
  const retained = [];
  const backupReferences = [];

  for (const skill of skills) {
    const digest = digestDirectory(skill.sourceDir);
    const oldSkill = manifest.skills.find((entry) => entry.id === skill.name) ?? null;
    const oldClaude = previousAttachment(oldSkill, 'claude');
    if (scope === 'global' && selectedAgents.includes('claude') && oldClaude
      && attachmentRootMismatch(oldClaude, targets, scope)) {
      throw new Error(`Existing Claude attachment is bound to ${oldClaude.targetRoot}; restore CLAUDE_CONFIG_DIR before installing or migrate explicitly.`);
    }
    const preserved = (oldSkill?.attachments ?? []).filter((entry) => !selectedAgents.includes(entry.host));
    const newAttachments = selectedAgents.map((host) => ({
      host,
      root: host === 'codex' ? 'agents' : 'claude',
      path: `skills/${skill.name}`,
      method: host === 'codex' ? 'direct' : (method === 'symlink' ? 'symlink' : 'copy'),
      sourceVersion: LINMAS_VERSION,
      sha256: digest,
      ...(scope === 'global' && host === 'claude' ? { targetRoot: targets.get('claude').rootPath } : {})
    }));
    const sharesCanonical = newAttachments.some(consumesCanonical) || preserved.some(consumesCanonical);
    const updatesCanonical = newAttachments.some(consumesCanonical);
    const oldCanonical = oldSkill?.canonical ?? null;
    let canonical = sharesCanonical
      ? (updatesCanonical
        ? { root: 'agents', path: `skills/${skill.name}`, sourceVersion: LINMAS_VERSION, sha256: digest }
        : oldCanonical)
      : null;

    const finalPreserved = preserved.map((entry) => updatesCanonical && consumesCanonical(entry)
      ? { ...entry, sourceVersion: LINMAS_VERSION, sha256: digest }
      : entry);
    const finalAttachments = [...finalPreserved, ...newAttachments];
    const nextSkill = { id: skill.name, canonical, attachments: finalAttachments };
    desired.push(nextSkill);

    const writes = [];
    if (updatesCanonical) {
      writes.push({
        host: 'codex', root: 'agents', relativePath: `skills/${skill.name}`,
        absolutePath: absoluteEntry('agents', `skills/${skill.name}`, targets, scopeRoot),
        rootPath: path.join(scopeRoot, '.agents'), parentPath: path.join(scopeRoot, '.agents', 'skills'),
        kind: 'copy', sourceDir: skill.sourceDir, digest, label: 'canonical', method: 'copy'
      });
    }
    for (const attachment of newAttachments) {
      if (attachment.host === 'codex') continue; // Codex consumes the canonical directory directly.
      const target = targets.get(attachment.host);
      const absolutePath = absoluteAttachment(attachment, targets, scopeRoot, scope);
      if (attachment.method === 'symlink') {
        writes.push({
          host: attachment.host, root: attachment.root, relativePath: attachment.path,
          absolutePath, rootPath: target.rootPath, parentPath: target.installRoot,
          kind: 'symlink', linkTarget: absoluteEntry('agents', `skills/${skill.name}`, targets, scopeRoot),
          digest, label: attachment.host, method: 'symlink'
        });
      } else {
        writes.push({
          host: attachment.host, root: attachment.root, relativePath: attachment.path,
          absolutePath, rootPath: target.rootPath, parentPath: target.installRoot,
          kind: 'copy', sourceDir: skill.sourceDir, digest, label: attachment.host, method: 'copy'
        });
      }
    }

    const uniqueWrites = [...new Map(writes.map((item) => [item.absolutePath, item])).values()];
    for (const operation of uniqueWrites) {
      assertInsideRoot(operation.rootPath, path.dirname(operation.absolutePath));
      const previous = operation.root === 'agents'
        ? oldCanonical
        : previousAttachment(oldSkill, operation.host);
      const previousPath = operation.root === 'agents'
        ? oldCanonical?.path === operation.relativePath ? oldCanonical : null
        : previous?.path === operation.relativePath ? previous : null;
      const record = previousPath;
      const recordLinkTarget = record?.method === 'symlink' ? absoluteEntry('agents', `skills/${skill.name}`, targets, scopeRoot) : operation.linkTarget;
      const state = stateOf(operation.absolutePath, record, { linkTarget: recordLinkTarget });
      const sameKind = operation.kind === 'symlink' ? record?.method === 'symlink' : record?.method !== 'symlink';
      const unchanged = state.state === 'managed' && operation.digest === (record?.sha256 ?? operation.digest) && sameKind;
      operation.state = state.state;
      operation.identity = state.identity;
      operation.record = record;
      operation.recordLinkTarget = recordLinkTarget;
      operation.write = !unchanged;
      operation.allowedConflict = state.state === 'unmanaged' ? 'unmanaged' : state.state === 'modified' ? 'modified' : null;
      if (operation.allowedConflict) {
        conflicts.push({ skill: skill.name, path: operation.absolutePath, kind: operation.allowedConflict, host: operation.host });
        operation.backupRootPath = path.join(scopeRoot, '.agents');
        operation.backupReference = createBackupReference(operation, { scope, skillId: skill.name });
        operation.backupAbsolutePath = path.join(operation.backupRootPath, ...operation.backupReference.backupPath.split('/'));
        backupReferences.push(operation.backupReference);
      }
      if (operation.write) operations.push(operation);
    }

    const newPhysical = new Set(uniqueWrites.map((entry) => entry.absolutePath));
    const oldPhysical = [];
    for (const attachment of oldSkill?.attachments ?? []) {
      const absolutePath = absoluteAttachment(attachment, targets, scopeRoot, scope);
      if (selectedAgents.includes(attachment.host) && !newPhysical.has(absolutePath)) {
        oldPhysical.push({ rootPath: attachmentRoot(attachment, targets, scopeRoot, scope), absolutePath, relativePath: attachment.path, host: attachment.host, record: attachment });
      }
    }
    if (oldCanonical && !canonical && !newPhysical.has(absoluteEntry('agents', oldCanonical.path, targets, scopeRoot))) {
      const absolutePath = absoluteEntry('agents', oldCanonical.path, targets, scopeRoot);
      const foreign = findForeignCanonicalReference(oldSkill, absolutePath, targets, scopeRoot, scope);
      if (foreign) {
        canonical = oldCanonical;
        nextSkill.canonical = oldCanonical;
        nextSkill.retainedReason = foreign.unknown ? 'reference-root-unavailable' : 'foreign-reference';
        retained.push({ skill: skill.name, path: absolutePath, reference: foreign.path, unknown: foreign.unknown });
      } else {
        oldPhysical.push({
          rootPath: path.join(scopeRoot, '.agents'), absolutePath,
          relativePath: oldCanonical.path, host: 'codex', record: oldCanonical,
          referenceGuard: { skill: oldSkill, canonicalPath: absolutePath, targets, scopeRoot, scope }
        });
      }
    }
    for (const obsolete of new Map(oldPhysical.map((item) => [item.absolutePath, item])).values()) {
      const state = stateOf(obsolete.absolutePath, obsolete.record, {
        linkTarget: obsolete.record?.method === 'symlink' && oldCanonical
          ? absoluteEntry('agents', oldCanonical.path, targets, scopeRoot)
          : undefined
      });
      if (state.state === 'missing') continue;
      const operation = {
        ...obsolete, kind: 'remove', parentPath: path.dirname(obsolete.absolutePath),
        state: state.state, identity: state.identity, write: true,
        record: obsolete.record,
        recordLinkTarget: obsolete.record?.method === 'symlink' && oldCanonical
          ? absoluteEntry('agents', oldCanonical.path, targets, scopeRoot)
          : undefined
      };
      if (state.state === 'modified') {
        conflicts.push({ skill: skill.name, path: operation.absolutePath, kind: 'modified', host: operation.host });
        operation.backupRootPath = path.join(scopeRoot, '.agents');
        operation.backupReference = createBackupReference(operation, { scope, skillId: skill.name });
        operation.backupAbsolutePath = path.join(operation.backupRootPath, ...operation.backupReference.backupPath.split('/'));
        backupReferences.push(operation.backupReference);
      }
      operations.push(operation);
    }
    if (updatesCanonical && preserved.some(consumesCanonical)) {
      affected.push({ skill: skill.name, hosts: preserved.filter(consumesCanonical).map((entry) => entry.host) });
    }
  }

  const selectedIds = new Set(skills.map((skill) => skill.name));
  const desiredById = new Map(desired.map((entry) => [entry.id, entry]));
  const nextSkills = manifest.skills.map((entry) => desiredById.get(entry.id) ?? entry);
  for (const entry of desired) if (!manifest.skills.some((current) => current.id === entry.id)) nextSkills.push(entry);
  const nextManifest = {
    ...manifest,
    version: LINMAS_VERSION,
    installedAt: manifest.installedAt,
    skills: nextSkills
  };
  if (manifest.backups || backupReferences.length) nextManifest.backups = [...(manifest.backups ?? []), ...backupReferences];
  if (manifest.skills.length === 0 && nextSkills.length > 0) nextManifest.installedAt = new Date().toISOString();
  validateScopedManifest(nextManifest, scope);
  const destinations = desired.map((skill) => ({
    id: skill.id,
    sourceVersion: LINMAS_VERSION,
    canonicalPath: skill.canonical ? absoluteEntry('agents', skill.canonical.path, targets, scopeRoot) : null,
    attachments: skill.attachments.map((attachment) => ({
      host: attachment.host,
      method: attachment.method,
      path: absoluteAttachment(attachment, targets, scopeRoot, scope)
    }))
  }));
  const manifestPath = path.join(scopeRoot, '.agents', 'linmas-manifest.json');
  const manifestStat = lstatMaybe(manifestPath);
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) throw new Error('Scoped manifest must be a regular file');
  return {
    scope, scopeRoot: path.resolve(scopeRoot), manifestPath, agents: selectedAgents, requestedMethod: method, destinations,
    originalManifestBytes: manifestStat ? fs.readFileSync(manifestPath, 'utf8') : null,
    currentManifest: manifest, nextManifest, selectedIds: [...selectedIds], operations, conflicts, affected, retained, dryRun,
    noOp: operations.length === 0 && JSON.stringify(manifest) === JSON.stringify(nextManifest)
  };
}

export function formatScopedInstallPreview(plan) {
  const lines = [`Linmas ${LINMAS_VERSION} ${plan.scope} install preview:`];
  for (const destination of plan.destinations) {
    lines.push(`- ${destination.id} (source ${destination.sourceVersion})`);
    lines.push(`  canonical: ${destination.canonicalPath ?? 'not created'}`);
    for (const attachment of destination.attachments) lines.push(`  ${attachment.host} ${attachment.method}: ${attachment.path}`);
    if (destination.canonicalPath) lines.push('  Visibility: other compatible harnesses may also discover shared .agents/skills content; host selection is not access control.');
  }
  lines.push(`Requested method: ${plan.requestedMethod}`);
  for (const operation of plan.operations) lines.push(`  ${operation.state}: ${operation.absolutePath}`);
  for (const operation of plan.operations) if (operation.backupAbsolutePath) lines.push(`  backup retained after approval: ${operation.backupAbsolutePath}`);
  for (const item of plan.affected) lines.push(`  shared canonical update also affects: ${item.hosts.join(', ')} (${item.skill})`);
  for (const item of plan.retained) lines.push(`  retained canonical for ${item.skill}; reference ${item.unknown ? 'could not be checked' : 'found'} at ${item.reference}`);
  if (plan.conflicts.length) lines.push(`Conflicts requiring separate approval: ${plan.conflicts.length}`);
  if (plan.dryRun) lines.push('Dry run: no files or lock state will be written.');
  return `${lines.join('\n')}\n`;
}

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, dereference: false });
}

function writeSnapshotAt(parentAnchor, fileName, contents) {
  parentAnchor.assertCurrent();
  const parent = parentAnchor.parentPath;
  const destination = path.join(parent, fileName);
  const current = lstatMaybe(destination);
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('Scoped manifest must be a regular file');
  const tempName = `.${fileName}.${process.pid}.${randomUUID()}.tmp`;
  const tempPath = path.join(parent, tempName);
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  const tempIdentity = fs.fstatSync(fd, { bigint: true });
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    parentAnchor.assertCurrent();
    fs.renameSync(tempPath, destination);
  } catch (error) {
    const tempStat = lstatMaybe(tempPath);
    if (tempStat && sameNode(tempStat, tempIdentity)) {
      try { fs.unlinkSync(tempPath); } catch (cleanupCause) { error.cleanupErrors = [...(error.cleanupErrors ?? []), cleanupCause]; }
    }
    throw error;
  }
  return lstatMaybe(destination);
}

function acquireScopeLock(scopeRoot) {
  const agentsRoot = path.join(scopeRoot, '.agents');
  ensureDirectory(agentsRoot);
  const anchor = openSafeMutationAnchors(agentsRoot, agentsRoot);
  const lockName = '.linmas-install.lock';
  const lockPath = path.join(anchor.parentPath, lockName);
  let identity;
  let created = false;
  try {
    anchor.assertCurrent();
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    created = true;
    try {
      identity = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (cause) {
    if (created && identity) {
      try { removeSafeLeaf(agentsRoot, path.join(agentsRoot, lockName), identity); }
      catch (cleanupCause) { cause.cleanupErrors = [...(cause.cleanupErrors ?? []), cleanupCause]; }
    }
    throw cause;
  } finally { anchor.close(); }
  return () => removeSafeLeaf(agentsRoot, path.join(agentsRoot, lockName), identity);
}

function ensurePlanDirectories(plan) {
  ensureDirectory(path.join(plan.scopeRoot, '.agents'));
  for (const operation of plan.operations) {
    if (operation.kind !== 'remove') {
      ensureDirectory(operation.rootPath);
      ensureDirectory(operation.parentPath);
    }
    if (operation.backupAbsolutePath) ensureDirectory(path.dirname(operation.backupAbsolutePath));
  }
}

function runAnchored(operation, callback) {
  const anchor = openSafeMutationAnchors(operation.rootPath, operation.parentPath);
  try {
    anchor.assertCurrent();
    return callback(anchor);
  } finally { anchor.close(); }
}

function renameAnchored(rootPath, parentPath, fromPath, toPath, expected) {
  return runAnchored({ rootPath, parentPath }, (anchor) => {
    const from = path.join(anchor.parentPath, path.basename(fromPath));
    const to = path.join(anchor.parentPath, path.basename(toPath));
    const current = lstatMaybe(from);
    if (!current || !sameNode(current, expected)) throw new Error(`Filesystem entry changed before rename: ${fromPath}`);
    if (lstatMaybe(to)) throw new Error(`Rename target already exists: ${toPath}`);
    fs.renameSync(from, to);
    return lstatMaybe(to);
  });
}

function retainBackup(operation, sourcePath) {
  const parentPath = path.dirname(operation.backupAbsolutePath);
  const name = path.basename(operation.backupAbsolutePath);
  const anchor = openSafeMutationAnchors(operation.backupRootPath, parentPath);
  const stageName = `.${name}.stage.${process.pid}.${randomUUID()}.tmp`;
  const stagePath = path.join(anchor.parentPath, stageName);
  const destination = path.join(anchor.parentPath, name);
  try {
    anchor.assertCurrent();
    if (lstatMaybe(destination)) throw new Error(`Backup destination already exists: ${operation.backupAbsolutePath}`);
    if (digestEntry(sourcePath) !== operation.backupReference.sha256) throw new Error(`Backup source changed after preview: ${operation.absolutePath}`);
    copyBackupEntry(sourcePath, stagePath);
    const staged = lstatMaybe(stagePath);
    if (!staged || digestEntry(stagePath) !== operation.backupReference.sha256) throw new Error(`Backup verification failed: ${operation.backupAbsolutePath}`);
    anchor.assertCurrent();
    if (lstatMaybe(destination)) throw new Error(`Backup destination appeared after preview: ${operation.backupAbsolutePath}`);
    fs.renameSync(stagePath, destination);
    const identity = lstatMaybe(destination);
    if (!identity || digestEntry(destination) !== operation.backupReference.sha256) throw new Error(`Retained backup changed during commit: ${operation.backupAbsolutePath}`);
    return { path: operation.backupAbsolutePath, identity, rootPath: operation.backupRootPath };
  } catch (cause) {
    const staged = lstatMaybe(stagePath);
    if (staged) {
      try { removeSafeLeaf(operation.backupRootPath, path.join(parentPath, stageName), staged); }
      catch (cleanupCause) { cause.cleanupErrors = [...(cause.cleanupErrors ?? []), cleanupCause]; }
    }
    throw cause;
  } finally { anchor.close(); }
}

function writeOperation(operation, journal) {
  return runAnchored(operation, (anchor) => {
    const destination = path.join(anchor.parentPath, path.basename(operation.absolutePath));
    const current = lstatMaybe(destination);
    if (operation.identity && !sameNode(current, operation.identity)) throw new Error(`Install destination changed after preview: ${operation.absolutePath}`);
    if (!operation.identity && current) throw new Error(`Install destination appeared after preview: ${operation.absolutePath}`);
    if (operation.state === 'managed'
      && stateOf(destination, operation.record, {
        linkTarget: operation.recordLinkTarget,
        linkBase: path.dirname(operation.absolutePath)
      }).state !== 'managed') {
      throw new Error(`Managed content changed after preview: ${operation.absolutePath}`);
    }
    if ((operation.state === 'unmanaged' || operation.state === 'modified') && !operation.approved) {
      throw new Error(`${operation.state === 'modified' ? 'Modified managed content' : 'Unmanaged content'} requires separate approval: ${operation.absolutePath}`);
    }

    let rollbackPath = null;
    let rollbackIdentity = null;
    let durableBackup = null;
    const stageName = `.${path.basename(operation.absolutePath)}.linmas-stage.${process.pid}.${randomUUID()}.tmp`;
    const stagePath = path.join(anchor.parentPath, stageName);
    try {
      if (current) {
        rollbackPath = path.join(path.dirname(operation.absolutePath), `.${path.basename(operation.absolutePath)}.linmas-rollback.${process.pid}.${randomUUID()}.tmp`);
        const anchoredRollback = path.join(anchor.parentPath, path.basename(rollbackPath));
        if (lstatMaybe(anchoredRollback)) throw new Error(`Install rollback path already exists: ${rollbackPath}`);
        fs.renameSync(destination, anchoredRollback);
        rollbackIdentity = lstatMaybe(anchoredRollback);
        if (!sameNode(current, rollbackIdentity)) throw new Error(`Install rollback identity changed: ${rollbackPath}`);
        if (operation.backupReference) durableBackup = retainBackup(operation, anchoredRollback);
      }
      if (operation.kind === 'symlink') {
        const relativeTarget = path.relative(path.dirname(operation.absolutePath), operation.linkTarget);
        try { fs.symlinkSync(relativeTarget, stagePath, 'dir'); }
        catch (error) {
          error.installMethod = 'symlink';
          if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) error.code = 'LINMAS_SYMLINK_UNAVAILABLE';
          throw error;
        }
      } else {
        copyTree(operation.sourceDir, stagePath);
        if (digestDirectory(stagePath) !== operation.digest) throw new Error(`Staged skill digest mismatch: ${operation.absolutePath}`);
      }
      anchor.assertCurrent();
      if (lstatMaybe(destination)) throw new Error(`Install destination appeared before commit: ${operation.absolutePath}`);
      fs.renameSync(stagePath, destination);
      const installedIdentity = lstatMaybe(destination);
      if (!installedIdentity) throw new Error(`Installed entry disappeared before journal commit: ${operation.absolutePath}`);
      journal.push({
        rootPath: operation.rootPath, parentPath: operation.parentPath, absolutePath: operation.absolutePath,
        identity: installedIdentity, rollbackPath, rollbackIdentity,
        backupRootPath: durableBackup?.rootPath, durableBackupPath: durableBackup?.path,
        durableBackupIdentity: durableBackup?.identity
      });
      return installedIdentity;
    } catch (cause) {
      const staged = lstatMaybe(stagePath);
      if (staged) {
        try { removeSafeLeaf(operation.rootPath, path.join(operation.parentPath, stageName), staged); }
        catch (cleanupCause) { cause.cleanupErrors = [...(cause.cleanupErrors ?? []), cleanupCause]; }
      }
      let restored = !current;
      const rollback = rollbackPath && lstatMaybe(path.join(anchor.parentPath, path.basename(rollbackPath)));
      if (rollback && rollbackIdentity && sameNode(rollback, rollbackIdentity) && !lstatMaybe(destination)) {
        try {
          anchor.assertCurrent();
          fs.renameSync(path.join(anchor.parentPath, path.basename(rollbackPath)), destination);
          restored = true;
        } catch (rollbackCause) {
          rollbackCause.recoveryPath = rollbackPath;
          cause.rollbackErrors = [...(cause.rollbackErrors ?? []), rollbackCause];
        }
      }
      if (durableBackup) {
        if (restored) {
          try { removeSafeLeaf(durableBackup.rootPath, durableBackup.path, durableBackup.identity); }
          catch (cleanupCause) {
            cause.cleanupErrors = [...(cause.cleanupErrors ?? []), cleanupCause];
            cause.recoveryPaths = [...(cause.recoveryPaths ?? []), durableBackup.path];
          }
        } else {
          cause.recoveryPaths = [...(cause.recoveryPaths ?? []), durableBackup.path];
        }
      }
      if (rollbackPath && !restored) {
        const recoveryPath = lstatMaybe(rollbackPath) && rollbackIdentity && sameNode(lstatMaybe(rollbackPath), rollbackIdentity)
          ? rollbackPath : durableBackup?.path ?? rollbackPath;
        const rollbackCause = new Error(`Install rollback could not restore ${operation.absolutePath}; recovery data ${recoveryPath ?? rollbackPath}`);
        rollbackCause.recoveryPath = recoveryPath ?? rollbackPath;
        cause.rollbackErrors = [...(cause.rollbackErrors ?? []), rollbackCause];
        cause.recoveryPaths = [...new Set([...(cause.recoveryPaths ?? []), rollbackCause.recoveryPath])];
      }
      throw cause;
    }
  });
}

function removeOperation(operation, journal) {
  return runAnchored(operation, (anchor) => {
    const destination = path.join(anchor.parentPath, path.basename(operation.absolutePath));
    const current = lstatMaybe(destination);
    if (!current || !sameNode(current, operation.identity)) throw new Error(`Uninstall target changed after preview: ${operation.absolutePath}`);
    if (operation.state === 'managed'
      && stateOf(destination, operation.record, {
        linkTarget: operation.recordLinkTarget,
        linkBase: path.dirname(operation.absolutePath)
      }).state !== 'managed') {
      throw new Error(`Uninstall target content changed after preview: ${operation.absolutePath}`);
    }
    if (operation.state === 'modified' && !operation.approved) throw new Error(`Modified managed content requires separate approval: ${operation.absolutePath}`);
    if (operation.referenceGuard) {
      const { skill, canonicalPath, targets, scopeRoot, scope } = operation.referenceGuard;
      const foreign = findForeignCanonicalReference(skill, canonicalPath, targets, scopeRoot, scope, journal);
      if (foreign) throw new Error(`Canonical payload acquired a reference after preview; preserving it because of ${foreign.path}`);
    }
    const rollbackPath = path.join(path.dirname(operation.absolutePath), `.${path.basename(operation.absolutePath)}.linmas-rollback.${process.pid}.${randomUUID()}.tmp`);
    const rollbackName = path.basename(rollbackPath);
    const rollback = path.join(anchor.parentPath, rollbackName);
    if (lstatMaybe(rollback)) throw new Error(`Uninstall rollback path already exists: ${rollbackPath}`);
    let rollbackIdentity;
    let durableBackup = null;
    try {
      fs.renameSync(destination, rollback);
      rollbackIdentity = lstatMaybe(rollback);
      if (!sameNode(current, rollbackIdentity)) throw new Error(`Uninstall rollback identity changed: ${rollbackPath}`);
      if (operation.backupReference) durableBackup = retainBackup(operation, rollback);
      journal.push({
        rootPath: operation.rootPath, parentPath: operation.parentPath, absolutePath: operation.absolutePath,
        identity: null, rollbackPath, rollbackIdentity, removed: true,
        backupRootPath: durableBackup?.rootPath, durableBackupPath: durableBackup?.path,
        durableBackupIdentity: durableBackup?.identity
      });
    } catch (cause) {
      const moved = lstatMaybe(rollback);
      let restored = false;
      if (moved && sameNode(moved, current) && !lstatMaybe(destination)) {
        try {
          anchor.assertCurrent();
          fs.renameSync(rollback, destination);
          restored = true;
        } catch (rollbackCause) { cause.rollbackErrors = [...(cause.rollbackErrors ?? []), rollbackCause]; }
      }
      if (durableBackup) {
        if (restored) {
          try { removeSafeLeaf(durableBackup.rootPath, durableBackup.path, durableBackup.identity); }
          catch (cleanupCause) {
            cause.cleanupErrors = [...(cause.cleanupErrors ?? []), cleanupCause];
            cause.recoveryPaths = [...(cause.recoveryPaths ?? []), durableBackup.path];
          }
        } else {
          cause.recoveryPaths = [...(cause.recoveryPaths ?? []), durableBackup.path];
        }
      }
      if (!restored) {
        const recoveryPath = moved && sameNode(moved, current) ? rollbackPath : durableBackup?.path ?? rollbackPath;
        const rollbackCause = new Error(`Uninstall rollback could not restore ${operation.absolutePath}; recovery data ${recoveryPath ?? rollbackPath}`);
        rollbackCause.recoveryPath = recoveryPath ?? rollbackPath;
        cause.rollbackErrors = [...(cause.rollbackErrors ?? []), rollbackCause];
        cause.recoveryPaths = [...new Set([...(cause.recoveryPaths ?? []), rollbackCause.recoveryPath])];
      }
      throw cause;
    }
  });
}

function rollbackWrites(journal, { keepBackups = false } = {}) {
  const errors = [];
  for (const item of [...journal].reverse()) {
    let restored = false;
    try {
      const current = lstatMaybe(item.absolutePath);
      if (item.rollbackPath && item.rollbackIdentity) {
        if (current) {
          if (item.identity && sameNode(current, item.identity)) removeSafeLeaf(item.rootPath, item.absolutePath, item.identity);
          else throw new Error(`Rollback destination is occupied by a different entry: ${item.absolutePath}`);
        }
        const rollback = lstatMaybe(item.rollbackPath);
        if (!rollback || !sameNode(rollback, item.rollbackIdentity)) throw new Error(`Rollback source is missing or changed: ${item.rollbackPath}`);
        if (lstatMaybe(item.absolutePath)) throw new Error(`Rollback destination appeared before restore: ${item.absolutePath}`);
        renameAnchored(item.rootPath, item.parentPath, item.rollbackPath, item.absolutePath, rollback);
        restored = true;
      } else if (!item.rollbackPath) {
        if (current && item.identity && sameNode(current, item.identity)) removeSafeLeaf(item.rootPath, item.absolutePath, item.identity);
        restored = !lstatMaybe(item.absolutePath);
        if (!restored) throw new Error(`Rollback could not remove the installed entry: ${item.absolutePath}`);
      } else {
        throw new Error(`Rollback journal is incomplete for ${item.absolutePath}`);
      }
    } catch (error) {
      error.recoveryPath ??= item.rollbackPath ?? item.absolutePath;
      errors.push(error);
    }
    if (item.durableBackupPath && item.durableBackupIdentity) {
      if (restored && !keepBackups) {
        try { removeSafeLeaf(item.backupRootPath, item.durableBackupPath, item.durableBackupIdentity); }
        catch (error) {
          error.recoveryPath = item.durableBackupPath;
          errors.push(error);
        }
      } else {
        const error = new Error(keepBackups ? 'Backup retained because manifest rollback was not verified' : 'Backup retained because filesystem rollback was incomplete');
        error.recoveryPath = item.durableBackupPath;
        errors.push(error);
      }
    }
  }
  return errors;
}

export function applyScopedInstallPlan(plan, { allowReplaceUnmanaged = false, allowReplaceModified = false, writeManifest = writeSnapshotAt } = {}) {
  assertSafeDestructiveFilesystem();
  for (const conflict of plan.conflicts) {
    if (conflict.kind === 'unmanaged' && !allowReplaceUnmanaged) throw new Error(`Unmanaged content requires separate approval: ${conflict.path}`);
    if (conflict.kind === 'modified' && !allowReplaceModified) throw new Error(`Modified managed content requires separate approval: ${conflict.path}`);
  }
  if (plan.noOp) return { status: 'NO_OP', installed: [], cleanupWarnings: [] };

  for (const operation of plan.operations) {
    operation.approved = operation.state === 'unmanaged' ? allowReplaceUnmanaged
      : operation.state === 'modified' ? allowReplaceModified : false;
  }
  ensurePlanDirectories(plan);
  const releaseLock = acquireScopeLock(plan.scopeRoot);
  const journal = [];
  const cleanupWarnings = [];
  let manifestAnchor;
  let manifestWriteAttempted = false;
  const nextManifestBytes = `${JSON.stringify(plan.nextManifest, null, 2)}\n`;
  let primaryError;
  let result;
  try {
    const existingManifest = lstatMaybe(plan.manifestPath);
    if (plan.originalManifestBytes === null) {
      if (existingManifest) throw new Error('Scoped manifest appeared after preview');
    } else if (!existingManifest || !existingManifest.isFile() || existingManifest.isSymbolicLink()
      || fs.readFileSync(plan.manifestPath, 'utf8') !== plan.originalManifestBytes) {
      throw new Error('Scoped manifest changed after preview');
    }
    for (const operation of plan.operations.filter((entry) => entry.kind !== 'remove')) writeOperation(operation, journal);
    for (const operation of plan.operations.filter((entry) => entry.kind === 'remove')) removeOperation(operation, journal);
    const agentsRoot = path.join(plan.scopeRoot, '.agents');
    manifestAnchor = openSafeMutationAnchors(agentsRoot, agentsRoot);
    manifestWriteAttempted = true;
    const manifestIdentity = writeManifest(manifestAnchor, 'linmas-manifest.json', nextManifestBytes);
    manifestAnchor.close();
    manifestAnchor = null;

    for (const item of journal) {
      if (!item.rollbackPath || !item.rollbackIdentity) continue;
      try { removeSafeLeaf(item.rootPath, item.rollbackPath, item.rollbackIdentity); }
      catch (cause) { cleanupWarnings.push({ path: item.rollbackPath, message: cause.message }); }
    }
    result = {
      status: cleanupWarnings.length ? 'COMMITTED_WITH_CLEANUP_WARNING' : 'COMMITTED',
      installed: journal.map((entry) => entry.absolutePath),
      retainedBackups: journal.filter((entry) => entry.durableBackupPath).map((entry) => entry.durableBackupPath),
      cleanupWarnings, manifestIdentity
    };
    return result;
  } catch (cause) {
    primaryError = cause;
    if (manifestAnchor) manifestAnchor.close();
    let manifestRestored = true;
    try {
      const current = lstatMaybe(plan.manifestPath);
      const currentBytes = current && current.isFile() && !current.isSymbolicLink() ? fs.readFileSync(plan.manifestPath, 'utf8') : null;
      if (manifestWriteAttempted && currentBytes === nextManifestBytes && currentBytes !== plan.originalManifestBytes) {
        const agentsRoot = path.join(plan.scopeRoot, '.agents');
        if (plan.originalManifestBytes === null) {
          if (current) removeSafeLeaf(agentsRoot, plan.manifestPath, current);
        } else {
          const anchor = openSafeMutationAnchors(agentsRoot, agentsRoot);
          try { writeSnapshotAt(anchor, 'linmas-manifest.json', plan.originalManifestBytes); }
          finally { anchor.close(); }
        }
      } else if (manifestWriteAttempted && currentBytes !== plan.originalManifestBytes && currentBytes !== nextManifestBytes) {
        throw new Error('Scoped manifest changed during rollback; preserving current bytes');
      }
    } catch (restoreError) {
      manifestRestored = false;
      cause.rollbackErrors = [...(cause.rollbackErrors ?? []), restoreError];
    }
    const rollbackErrors = rollbackWrites(journal, { keepBackups: !manifestRestored });
    if (rollbackErrors.length) cause.rollbackErrors = [...(cause.rollbackErrors ?? []), ...rollbackErrors];
    const recoveryPaths = rollbackErrors.map((error) => error.recoveryPath).filter(Boolean);
    if (recoveryPaths.length) cause.recoveryPaths = [...new Set([...(cause.recoveryPaths ?? []), ...recoveryPaths])];
    throw cause;
  } finally {
    try { releaseLock(); }
    catch (error) {
      if (primaryError) primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), error];
      else {
        cleanupWarnings.push({ path: path.join(plan.scopeRoot, '.agents', '.linmas-install.lock'), message: error.message });
        if (result) result.status = 'COMMITTED_WITH_CLEANUP_WARNING';
      }
    }
  }
}

export function planScopedUninstall({ manifest, targets, scope, scopeRoot, skillNames = [], agents, uninstallAll = false }) {
  validateScopedManifest(manifest, scope);
  if (!uninstallAll && !skillNames.length) throw new Error('uninstall requires a skill or --all');
  const selectedAgents = normalizeAgents(agents);
  const selectedSkills = new Set(uninstallAll ? manifest.skills.map((skill) => skill.id) : skillNames.flatMap((name) => {
    const entry = manifest.skills.find((skill) => matchesSkillIdentifier(skill.id, name));
    if (!entry) throw new Error(`skill is not managed in ${scope} scope: ${name}`);
    return [entry.id];
  }));
  const operations = [];
  const skipped = [];
  const nextSkills = [];

  for (const skill of manifest.skills) {
    if (!selectedSkills.has(skill.id)) {
      nextSkills.push(skill);
      continue;
    }
    const remaining = skill.attachments.filter((entry) => !selectedAgents.includes(entry.host));
    const removing = skill.attachments.filter((entry) => selectedAgents.includes(entry.host));
    const canonicalStillUsed = remaining.some(consumesCanonical);
    const nextAttachments = [...remaining];
    const canonicalPath = skill.canonical ? absoluteEntry('agents', skill.canonical.path, targets, scopeRoot) : null;

    for (const attachment of removing) {
      if (attachmentRootMismatch(attachment, targets, scope)) {
        const absolutePath = path.resolve(attachment.targetRoot, ...attachment.path.split('/'));
        skipped.push({ skill: skill.id, host: attachment.host, path: absolutePath, reason: 'configuration root mismatch' });
        nextAttachments.push(attachment);
        continue;
      }
      const absolutePath = absoluteAttachment(attachment, targets, scopeRoot, scope);
      const sameAsCanonical = canonicalPath && absolutePath === canonicalPath;
      if (sameAsCanonical) continue;
      const linkTarget = attachment.method === 'symlink' && canonicalPath ? canonicalPath : undefined;
      const state = stateOf(absolutePath, attachment, { linkTarget });
      if (state.state === 'missing') continue;
      if (state.state !== 'managed') {
        skipped.push({ skill: skill.id, host: attachment.host, path: absolutePath, reason: state.state });
        nextAttachments.push(attachment);
        continue;
      }
      operations.push({
        kind: 'remove', rootPath: attachmentRoot(attachment, targets, scopeRoot, scope),
        parentPath: path.dirname(absolutePath), absolutePath, relativePath: attachment.path,
        host: attachment.host, state: state.state, identity: state.identity, write: true,
        record: attachment, recordLinkTarget: linkTarget
      });
    }

    const keptCanonical = canonicalStillUsed || nextAttachments.some(consumesCanonical);
    let canonical = keptCanonical ? skill.canonical : null;
    let retainedReason = null;
    if (skill.canonical && !keptCanonical && canonicalPath && !operations.some((entry) => entry.absolutePath === canonicalPath)) {
      const state = stateOf(canonicalPath, skill.canonical);
      if (state.state === 'missing') {
        canonical = null;
      } else {
        const foreign = findForeignCanonicalReference(skill, canonicalPath, targets, scopeRoot, scope);
        if (foreign) {
          canonical = skill.canonical;
          retainedReason = foreign.unknown ? 'reference-root-unavailable' : 'foreign-reference';
          skipped.push({ skill: skill.id, host: 'codex', path: canonicalPath, reason: `${retainedReason}: ${foreign.path}` });
        } else if (state.state === 'managed') {
        operations.push({
          kind: 'remove', rootPath: path.join(scopeRoot, '.agents'), parentPath: path.dirname(canonicalPath),
          absolutePath: canonicalPath, relativePath: skill.canonical.path, host: 'codex',
          state: state.state, identity: state.identity, write: true, record: skill.canonical,
          referenceGuard: { skill, canonicalPath, targets, scopeRoot, scope }
        });
        canonical = null;
        } else {
          canonical = skill.canonical;
          retainedReason = 'modified';
          skipped.push({ skill: skill.id, host: 'codex', path: canonicalPath, reason: state.state });
        }
      }
    }

    if (nextAttachments.length || (canonical && retainedReason)) {
      const nextSkill = { ...skill, canonical, attachments: nextAttachments };
      if (retainedReason) nextSkill.retainedReason = retainedReason;
      else delete nextSkill.retainedReason;
      nextSkills.push(nextSkill);
    }
  }

  const nextManifest = { ...manifest, version: LINMAS_VERSION, skills: nextSkills };
  validateScopedManifest(nextManifest, scope);
  const manifestPath = path.join(scopeRoot, '.agents', 'linmas-manifest.json');
  const manifestStat = lstatMaybe(manifestPath);
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) throw new Error('Scoped manifest must be a regular file');
  return {
    scope, scopeRoot: path.resolve(scopeRoot), manifestPath,
    originalManifestBytes: manifestStat ? fs.readFileSync(manifestPath, 'utf8') : null,
    currentManifest: manifest, nextManifest, operations, skipped,
    noOp: operations.length === 0 && JSON.stringify(manifest) === JSON.stringify(nextManifest)
  };
}

export function formatScopedUninstallPreview(plan) {
  const lines = [`Linmas ${plan.scope} uninstall preview:`];
  for (const operation of plan.operations) lines.push(`- remove ${operation.host}: ${operation.absolutePath}`);
  for (const item of plan.skipped) lines.push(`- keep ${item.skill} (${item.reason}): ${item.path}`);
  return `${lines.join('\n')}\n`;
}

export function applyScopedUninstallPlan(plan, { writeManifest = writeSnapshotAt } = {}) {
  assertSafeDestructiveFilesystem();
  if (plan.noOp) return { status: 'NO_OP', removed: [], skipped: plan.skipped };
  const releaseLock = acquireScopeLock(plan.scopeRoot);
  const journal = [];
  let manifestAnchor;
  let manifestWriteAttempted = false;
  let primaryError;
  const cleanupWarnings = [];
  const nextManifestBytes = `${JSON.stringify(plan.nextManifest, null, 2)}\n`;
  let result;
  let manifestRestored = true;
  try {
    const current = lstatMaybe(plan.manifestPath);
    if (plan.originalManifestBytes === null) {
      if (current) throw new Error('Scoped manifest appeared after preview');
    } else if (!current || !current.isFile() || current.isSymbolicLink()
      || fs.readFileSync(plan.manifestPath, 'utf8') !== plan.originalManifestBytes) {
      throw new Error('Scoped manifest changed after preview');
    }
    for (const operation of plan.operations) removeOperation(operation, journal);
    const agentsRoot = path.join(plan.scopeRoot, '.agents');
    manifestAnchor = openSafeMutationAnchors(agentsRoot, agentsRoot);
    manifestWriteAttempted = true;
    writeManifest(manifestAnchor, 'linmas-manifest.json', nextManifestBytes);
    manifestAnchor.close();
    manifestAnchor = null;
    for (const item of journal) {
      if (!item.rollbackPath || !item.rollbackIdentity) continue;
      try { removeSafeLeaf(item.rootPath, item.rollbackPath, item.rollbackIdentity); }
      catch (cause) { cleanupWarnings.push({ path: item.rollbackPath, message: cause.message }); }
    }
    result = {
      status: cleanupWarnings.length ? 'COMMITTED_WITH_CLEANUP_WARNING' : 'COMMITTED',
      removed: journal.map((entry) => entry.absolutePath), skipped: plan.skipped, cleanupWarnings,
      retainedBackups: journal.filter((entry) => entry.durableBackupPath).map((entry) => entry.durableBackupPath)
    };
    return result;
  } catch (cause) {
    primaryError = cause;
    if (manifestAnchor) manifestAnchor.close();
    try {
      const current = lstatMaybe(plan.manifestPath);
      const currentBytes = current && current.isFile() && !current.isSymbolicLink() ? fs.readFileSync(plan.manifestPath, 'utf8') : null;
      if (manifestWriteAttempted && currentBytes === nextManifestBytes && currentBytes !== plan.originalManifestBytes) {
        const agentsRoot = path.join(plan.scopeRoot, '.agents');
        if (plan.originalManifestBytes === null) {
          if (current) removeSafeLeaf(agentsRoot, plan.manifestPath, current);
        } else {
          const anchor = openSafeMutationAnchors(agentsRoot, agentsRoot);
          try { writeSnapshotAt(anchor, 'linmas-manifest.json', plan.originalManifestBytes); }
          finally { anchor.close(); }
        }
      } else if (manifestWriteAttempted && currentBytes !== plan.originalManifestBytes && currentBytes !== nextManifestBytes) {
        throw new Error('Scoped manifest changed during rollback; preserving current bytes');
      }
    } catch (restoreError) {
      manifestRestored = false;
      cause.rollbackErrors = [...(cause.rollbackErrors ?? []), restoreError];
    }
    const errors = rollbackWrites(journal, { keepBackups: !manifestRestored });
    if (errors.length) cause.rollbackErrors = [...(cause.rollbackErrors ?? []), ...errors];
    const recoveryPaths = errors.map((error) => error.recoveryPath).filter(Boolean);
    if (recoveryPaths.length) cause.recoveryPaths = [...new Set([...(cause.recoveryPaths ?? []), ...recoveryPaths])];
    throw cause;
  } finally {
    try { releaseLock(); }
    catch (error) {
      if (primaryError) primaryError.cleanupErrors = [...(primaryError.cleanupErrors ?? []), error];
      else {
        cleanupWarnings.push({ path: path.join(plan.scopeRoot, '.agents', '.linmas-install.lock'), message: error.message });
        if (result) result.status = 'COMMITTED_WITH_CLEANUP_WARNING';
      }
    }
  }
}

export function formatScopedDoctorReport({ manifest, targets, scope, scopeRoot, legacyRoots = [] }) {
  validateScopedManifest(manifest, scope);
  const lines = [`Linmas doctor report (${scope} scope):`];
  const managed = new Set();
  for (const skill of manifest.skills) {
    const canonicalPath = skill.canonical ? absoluteEntry('agents', skill.canonical.path, targets, scopeRoot) : null;
    const canonicalState = canonicalPath ? stateOf(canonicalPath, skill.canonical).state : null;
    if (canonicalPath) {
      managed.add(canonicalPath);
      lines.push(`- ${skill.id} / canonical: ${skill.retainedReason ? `retained (${skill.retainedReason})` : canonicalState} at ${canonicalPath}`);
    }
    for (const attachment of skill.attachments) {
      if (attachmentRootMismatch(attachment, targets, scope)) {
        const recordedRoot = path.resolve(attachment.targetRoot);
        const absolutePath = path.resolve(recordedRoot, ...attachment.path.split('/'));
        managed.add(absolutePath);
        lines.push(`- ${skill.id} / ${attachment.host}: configuration root mismatch (recorded ${recordedRoot}; current ${targets.get('claude').rootPath}) at ${absolutePath}`);
        continue;
      }
      const absolutePath = absoluteAttachment(attachment, targets, scopeRoot, scope);
      managed.add(absolutePath);
      let state = stateOf(absolutePath, attachment, {
        linkTarget: attachment.method === 'symlink' ? canonicalPath : undefined
      }).state;
      if (attachment.method === 'symlink' && state === 'managed') {
        if (canonicalState === 'missing') state = 'broken-link';
        else if (canonicalState === 'modified') state = 'canonical-modified';
      }
      lines.push(`- ${skill.id} / ${attachment.host}: ${state} (${attachment.method}) at ${absolutePath}`);
    }
  }
  for (const root of legacyRoots) {
    for (const skill of manifest.skills) {
      const candidate = path.join(root, skill.id);
      if (fs.existsSync(candidate) && !managed.has(candidate)) lines.push(`- possible duplicate or foreign install: ${candidate}`);
    }
  }
  if (manifest.skills.length === 0) lines.push('- no scoped skills are managed');
  return `${lines.join('\n')}\n`;
}
