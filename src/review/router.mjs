const ROUTES = [
  ['cloud-hardening-architect', /\b(iam|bucket|cloud|terraform)\b/i],
  ['smart-contract-reviewer', /\b(solidity|contract|evm)\b/i],
  ['detection-rules-engineer', /\b(sigma|detection rule|siem)\b/i],
  ['secure-code-reviewer', /\b(code|diff|query|function|class)\b/i]
];

export function recommendSpecialists(content) {
  return ROUTES
    .filter(([, pattern]) => pattern.test(content))
    .map(([name]) => resolveSkill(name)?.skillId)
    .filter(Boolean)
    .slice(0, 3);
}
import { resolveSkill } from '../core/skill-catalog.mjs';
