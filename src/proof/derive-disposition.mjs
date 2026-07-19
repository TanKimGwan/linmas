import { DISPOSITIONS, OVERALL_DISPOSITIONS } from './constants.mjs';

export function deriveOverallDisposition(findings) {
  if (!Array.isArray(findings)) throw new Error('proof findings must be an array');
  for (const finding of findings) {
    if (!finding || !DISPOSITIONS.includes(finding.disposition)) throw new Error('proof finding disposition is invalid');
  }
  if (findings.length === 0) return 'no-findings-reported';
  if (findings.some((finding) => finding.disposition === 'remediation-required')) return 'remediation-required';
  if (findings.some((finding) => finding.disposition === 'needs-more-evidence')) return 'needs-more-evidence';
  if (findings.some((finding) => finding.disposition === 'accepted-risk')) return 'accepted-risk';
  return 'no-action';
}

export function assertOverallDisposition(value) {
  if (!OVERALL_DISPOSITIONS.includes(value)) throw new Error('proof overall disposition is invalid');
}
