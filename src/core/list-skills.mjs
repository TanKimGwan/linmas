import fs from 'node:fs';
import path from 'node:path';

export const EXPECTED_SKILLS = [
  'security-operations-lead',
  'smart-contract-reviewer',
  'exploit-validation-specialist',
  'threat-research-analyst',
  'detection-rules-engineer',
  'incident-triage-lead',
  'controls-compliance-reviewer',
  'cloud-hardening-architect',
  'secure-systems-architect',
  'secure-code-reviewer',
  'security-domain-router'
];

function readDescription(skillFile) {
  const text = fs.readFileSync(skillFile, 'utf8');
  const match = text.match(/^description:\s*(.+)$/m);
  return match ? match[1].trim() : 'No description found';
}

export function listSkills(rootDir) {
  return EXPECTED_SKILLS.map((name) => {
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
