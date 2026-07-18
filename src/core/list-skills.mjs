import fs from 'node:fs';
import path from 'node:path';
import { SKILL_CATALOG, SPECIALIST_IDS } from './skill-catalog.mjs';

export const EXPECTED_SKILLS = SPECIALIST_IDS;

function readDescription(skillFile) {
  const text = fs.readFileSync(skillFile, 'utf8');
  const match = text.match(/^description:\s*(.+)$/m);
  return match ? match[1].trim() : 'No description found';
}

export function listSkills(rootDir) {
  return SKILL_CATALOG.map((entry) => {
    const sourceDir = path.join(rootDir, 'skills', entry.skillId);
    const skillFile = path.join(sourceDir, 'SKILL.md');
    return {
      name: entry.skillId,
      specialistId: entry.specialistId,
      legacyAliases: entry.legacyAliases,
      kind: entry.kind,
      description: readDescription(skillFile),
      sourceDir,
      skillFile
    };
  });
}
