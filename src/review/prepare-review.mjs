import { resolveSkill } from '../core/skill-catalog.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { recommendSpecialists } from './router.mjs';

export function prepareReview({ input, skillName }) {
  const selected = skillName ? resolveSkill(skillName) : null;
  if (skillName && (!selected || selected.kind !== 'specialist')) {
    throw new ReviewError(`unknown specialist: ${skillName}`, 'input', EXIT_CODES.INPUT);
  }
  return {
    schemaVersion: 1,
    source: input.source,
    bytes: input.bytes,
    specialist: selected?.specialistId ?? null,
    recommendations: skillName ? [] : recommendSpecialists(input.content),
    mode: 'advisor-review',
    input: input.content,
    humanReviewRequired: true
  };
}
