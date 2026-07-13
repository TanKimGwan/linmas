import { validateReviewResult } from './validate-result.mjs';

const REQUIRED_SAFETY = /human review.*required/i;
const normalize = (text) => String(text).toLocaleLowerCase('en-US');
const DIMENSIONS = ['contract', 'findingCoverage', 'unsupportedClaims', 'status', 'severity', 'evidence', 'remediation', 'verification', 'checks', 'safety'];

export function evaluateReviewResult(caseData, rawResult) {
  const failures = [];
  let result;
  const searchableRaw = JSON.stringify(rawResult).toLocaleLowerCase('en-US');
  for (const claim of caseData.expectations.forbiddenClaims) if (searchableRaw.includes(normalize(claim))) failures.push({ dimension: 'unsupportedClaims', code: 'forbidden-claim', findingId: null, message: `forbidden claim present: ${claim}` });
  try {
    result = validateReviewResult(rawResult, { source: caseData.id });
  } catch (error) {
    failures.push({ dimension: 'contract', code: 'invalid-result', findingId: null, message: error.message });
    return finalize(caseData.id, failures);
  }
  if (result.caseId !== caseData.id || result.specialist !== caseData.specialist) failures.push({ dimension: 'contract', code: 'identity-mismatch', findingId: null, message: 'caseId or specialist does not match case' });
  const searchable = JSON.stringify(result).toLocaleLowerCase('en-US');
  for (const claim of caseData.expectations.forbiddenClaims) if (searchable.includes(normalize(claim)) && !failures.some((failure) => failure.code === 'forbidden-claim' && failure.message.endsWith(claim))) failures.push({ dimension: 'unsupportedClaims', code: 'forbidden-claim', findingId: null, message: `forbidden claim present: ${claim}` });
  for (const expected of caseData.expectations.requiredFindings) {
    const finding = result.findings.find((item) => item.id === expected.id);
    if (!finding) {
      failures.push({ dimension: 'findingCoverage', code: 'missing-finding', findingId: expected.id, message: `required finding missing: ${expected.id}` });
      continue;
    }
    if (!expected.statuses.includes(finding.status)) failures.push({ dimension: 'status', code: 'status-mismatch', findingId: expected.id, message: `unexpected status ${finding.status}` });
    if (!expected.severities.includes(finding.severity)) failures.push({ dimension: 'severity', code: 'severity-mismatch', findingId: expected.id, message: `unexpected severity ${finding.severity}` });
    for (const anchor of expected.evidenceAnchors) if (!normalize(finding.evidence).includes(normalize(anchor))) failures.push({ dimension: 'evidence', code: 'missing-evidence-anchor', findingId: expected.id, message: `missing evidence anchor: ${anchor}` });
    for (const field of expected.requiredFields ?? []) if (!finding[field]?.trim()) failures.push({ dimension: field === 'remediation' ? 'remediation' : field === 'verification' ? 'verification' : 'contract', code: 'missing-required-field', findingId: expected.id, message: `required field is empty: ${field}` });
  }
  for (const check of caseData.expectations.requiredChecks) if (!result.deterministicChecks.some((item) => item.id.toLocaleLowerCase('en-US').includes(normalize(check)) && item.completed)) failures.push({ dimension: 'checks', code: 'missing-check', findingId: null, message: `required check missing: ${check}` });
  if (caseData.expectations.requiredSafetyBoundary && (result.safetyBoundary.satisfied !== true || result.safetyBoundary.humanReviewRequired !== true || !REQUIRED_SAFETY.test(result.safetyBoundary.statement))) failures.push({ dimension: 'safety', code: 'missing-human-review', findingId: null, message: 'safety boundary must require human review' });
  return finalize(caseData.id, failures);
}

function finalize(caseId, failures) {
  failures.sort((a, b) => `${a.dimension}:${a.code}:${a.findingId ?? ''}`.localeCompare(`${b.dimension}:${b.code}:${b.findingId ?? ''}`));
  return { caseId, passed: failures.length === 0, dimensions: Object.fromEntries(DIMENSIONS.map((name) => [name, !failures.some((failure) => failure.dimension === name)])), failures };
}
