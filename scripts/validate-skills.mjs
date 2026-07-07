import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_SKILLS } from '../src/core/list-skills.mjs';

const root = process.cwd();
const skillsRoot = path.join(root, 'skills');

const expectedSkills = EXPECTED_SKILLS;

const requiredHeadings = [
  '## Best fit',
  '## Use another skill when',
  '## Operating guardrails',
  '## Intake checklist',
  '## Output contract'
];

const forbiddenSkill = 'security';

const forbiddenPatterns = [
  /^\.env$/,
  /^\.env\..+/,
  /^.*\.log$/,
  /^.*\.bak$/,
  /^.*\.tmp$/,
  /^\.DS_Store$/
];

// Mirror the intended npm publish surface from package.json.
const publishedSurface = [
  'bin',
  'src',
  'README.md',
  'package.json',
  'scripts',
  'skills',
  'LICENSE',
  'NOTICE',
  'TRADEMARK.md'
];

const secretPattern = /(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|password=|token=|api[_-]?key=|apikey=)/;
const safeSecretExamplePatterns = [
  'grep -RInE',
  'sk-...',
  'ghp_...',
  'github_pat_...',
  'AKIA...',
  '<API_TOKEN>',
  '<ACCESS_TOKEN>',
  'example-token',
  'const secretPattern ='
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function existsAsDir(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function existsAsFile(targetPath) {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function readText(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);

    if (entry.isSymbolicLink()) {
      fail(`Symlink is not allowed: ${relPath}`);
      continue;
    }

    if (forbiddenPatterns.some((pattern) => pattern.test(entry.name))) {
      fail(`Forbidden file found: ${relPath}`);
    }

    if (entry.isDirectory()) {
      walk(fullPath);
    }
  }
}

function listTopLevelSkillDirs() {
  if (!existsAsDir(skillsRoot)) return [];

  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const frontmatter = match[1];
  const data = {};
  for (const line of frontmatter.split('\n')) {
    if (/^\s/.test(line) || !line.includes(':')) continue;
    const [rawKey, ...rest] = line.split(':');
    data[rawKey.trim()] = rest.join(':').trim();
  }
  return data;
}

function validateSkillContent(skill, skillFile) {
  const relPath = path.relative(root, skillFile);
  const text = readText(skillFile);

  if (text === null) {
    fail(`Skill file is not readable UTF-8 text: ${relPath}`);
    return;
  }

  const frontmatter = parseFrontmatter(text);
  if (!frontmatter) {
    fail(`Missing frontmatter: ${relPath}`);
    return;
  }

  for (const key of ['name', 'description', 'triggers']) {
    if (!(key in frontmatter)) {
      fail(`Missing frontmatter key '${key}': ${relPath}`);
    }
  }

  if (frontmatter.name && frontmatter.name !== skill) {
    fail(`Frontmatter name must match directory name in ${relPath}: expected '${skill}', found '${frontmatter.name}'`);
  }

  if (!/^#\s+.+/m.test(text)) {
    fail(`Missing H1 title: ${relPath}`);
  }

  for (const heading of requiredHeadings) {
    if (!text.includes(heading)) {
      fail(`Missing required heading '${heading}' in ${relPath}`);
    }
  }

  if (!/\bauthorized\b/i.test(text)) {
    fail(`Missing explicit authorized-use language in ${relPath}`);
  }
}

function shouldIgnoreSecretMatch(line) {
  return safeSecretExamplePatterns.some((pattern) => line.includes(pattern));
}

function scanTextForSecrets(fullPath) {
  const relPath = path.relative(root, fullPath);
  const text = readText(fullPath);
  if (text === null) return;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!secretPattern.test(line)) continue;
    if (shouldIgnoreSecretMatch(line)) continue;
    fail(`Secret-like pattern found: ${relPath}:${i + 1}`);
  }
}

function walkPublishedSurface(targetPath) {
  if (!fs.existsSync(targetPath)) return;

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    scanTextForSecrets(targetPath);
    return;
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    walkPublishedSurface(path.join(targetPath, entry.name));
  }
}

if (!existsAsDir(skillsRoot)) {
  fail('Missing skills/ directory');
}

const forbiddenPath = path.join(skillsRoot, forbiddenSkill);
if (fs.existsSync(forbiddenPath)) {
  fail('skills/security must not be included unless intentionally normalized');
}

const topLevelSkillDirs = listTopLevelSkillDirs();
const unexpectedSkills = topLevelSkillDirs.filter((name) => name !== forbiddenSkill && !expectedSkills.includes(name));
for (const skill of unexpectedSkills) {
  const skillFile = path.join(skillsRoot, skill, 'SKILL.md');
  if (existsAsFile(skillFile)) {
    fail(`Unexpected installable skill directory: skills/${skill}`);
  }
}

for (const skill of expectedSkills) {
  const skillDir = path.join(skillsRoot, skill);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!existsAsDir(skillDir)) {
    fail(`Missing skill directory: skills/${skill}`);
    continue;
  }

  if (!existsAsFile(skillFile)) {
    fail(`Missing SKILL.md: skills/${skill}/SKILL.md`);
    continue;
  }

  validateSkillContent(skill, skillFile);
}

if (existsAsDir(skillsRoot)) {
  walk(skillsRoot);
}

for (const target of publishedSurface) {
  walkPublishedSurface(path.join(root, target));
}

if (failures.length > 0) {
  console.error('Validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Validation passed.');
console.log(`Validated ${expectedSkills.length} skills.`);
