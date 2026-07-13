import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReview } from '../src/review/prepare-review.mjs';

test('prepares a selected specialist request without execution metadata', () => {
  const request = prepareReview({
    input: { source: 'patch.diff', content: '+ db.query(sql)', bytes: 15 },
    skillName: 'secure-code-reviewer'
  });
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.specialist, 'secure-code-reviewer');
  assert.equal(request.humanReviewRequired, true);
  assert.equal('provider' in request, false);
});

test('shows router recommendations when no specialist is selected', () => {
  const request = prepareReview({ input: { source: 'cloud.tf', content: 'public bucket policy', bytes: 20 }, skillName: null });
  assert.equal(request.specialist, null);
  assert.deepEqual(request.recommendations, ['cloud-hardening-architect']);
});

test('rejects the router as an executable specialist', () => {
  assert.throws(() => prepareReview({ input: { source: 'x', content: 'x', bytes: 1 }, skillName: 'security-domain-router' }), /unknown specialist/);
});
