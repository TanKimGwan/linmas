export const CANONICAL_SAFETY_BOUNDARY = Object.freeze({
  satisfied: true,
  humanReviewRequired: true,
  statement: 'Human review remains required.'
});

export const DISPOSITIONS = Object.freeze([
  'remediation-required',
  'accepted-risk',
  'false-positive',
  'needs-more-evidence'
]);

export const OVERALL_DISPOSITIONS = Object.freeze([
  'remediation-required',
  'accepted-risk',
  'no-action',
  'needs-more-evidence',
  'no-findings-reported'
]);

export const MAX_PROOF_TEXT = 16 * 1024;
export const MAX_CAPSULE_SOURCE_BYTES = 16 * 1024 * 1024;
