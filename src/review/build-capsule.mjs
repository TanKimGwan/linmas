import { createHash } from 'node:crypto';
import { validateReviewResult } from '../evaluation/validate-result.mjs';
import { validateReviewCapsule } from './validate-capsule.mjs';

export function fingerprintReviewInput(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError('review input bytes are required');
  return createHash('sha256').update(value).digest('hex');
}

export function buildReviewCapsule({ input, execution, review, policyResult = null, now = new Date() } = {}) {
  const normalizedReview = validateReviewResult(review, { source: 'capsule review' });
  normalizedReview.modelMetadata.requestId = null;
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const capsule = {
    schemaVersion: 1,
    kind: 'linmas-review-capsule',
    input: {
      source: input?.source,
      bytes: input?.bytes,
      sha256: input?.sha256
    },
    execution: {
      mode: execution?.mode,
      provider: execution?.provider,
      authMode: execution?.authMode,
      model: execution?.model,
      modelVerified: execution?.modelVerified === true,
      generatedAt
    },
    review: normalizedReview,
    policy: policyResult === null
      ? { status: 'not-evaluated', result: null }
      : { status: 'evaluated', result: structuredClone(policyResult) },
    safetyBoundary: structuredClone(normalizedReview.safetyBoundary)
  };
  return validateReviewCapsule(capsule);
}
