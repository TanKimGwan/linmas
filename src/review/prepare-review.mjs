import { EXPECTED_SKILLS } from '../core/list-skills.mjs';
import { EXIT_CODES, ReviewError } from './errors.mjs';
import { recommendSpecialists } from './router.mjs';

export function prepareReview({ input, skillName }) {
  if (skillName && (!EXPECTED_SKILLS.includes(skillName) || skillName === 'security-domain-router')) {
    throw new ReviewError(`unknown specialist: ${skillName}`, 'input', EXIT_CODES.INPUT);
  }
  return {
    schemaVersion: 1,
    source: input.source,
    bytes: input.bytes,
    specialist: skillName,
    recommendations: skillName ? [] : recommendSpecialists(input.content),
    mode: 'advisor-review',
    input: input.content,
    humanReviewRequired: true
  };
}
