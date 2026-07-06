import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..', '..');

function listInstallableSkillNames(rootDir) {
  const skillsRoot = path.join(rootDir, 'skills');

  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'security')
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, 'SKILL.md')))
    .sort();
}

export const EXPECTED_SKILLS = listInstallableSkillNames(defaultRootDir);

function readDescription(skillFile) {
  const text = fs.readFileSync(skillFile, 'utf8');
  const match = text.match(/^description:\s*(.+)$/m);
  return match ? match[1].trim() : 'No description found';
}

export function listSkills(rootDir) {
  return listInstallableSkillNames(rootDir).map((name) => {
    const sourceDir = path.join(rootDir, 'skills', name);
    const skillFile = path.join(sourceDir, 'SKILL.md');
    return {
      name,
      description: readDescription(skillFile),
      sourceDir,
      skillFile
    };
  });
}
