const RANK = { pass: 0, 'needs-review': 1, blocked: 2 };

function maxDecision(left, right) {
  return RANK[right] > RANK[left] ? right : left;
}

function findingMatches(reviewResult, rule) {
  return reviewResult.findings.filter((finding) => {
    if (rule.severities && !rule.severities.includes(finding.severity)) return false;
    return !rule.statuses || rule.statuses.includes(finding.status);
  });
}

export function evaluatePolicy(pack, reviewResult) {
  let decision = 'pass';
  const rules = [];
  const completed = new Set(reviewResult.deterministicChecks.filter((check) => check.completed).map((check) => check.id));

  if (reviewResult.safetyBoundary?.satisfied !== true || reviewResult.safetyBoundary?.humanReviewRequired !== true) {
    decision = 'blocked';
    rules.push({
      id: 'linmas-safety',
      outcome: 'failed',
      decision: 'blocked',
      reason: 'Linmas safety boundary or human-review requirement failed.'
    });
  }

  for (const rule of pack.rules) {
    if (rule.type === 'minimum-checks') {
      const missing = rule.checks.filter((id) => !completed.has(id));
      const next = missing.length ? 'needs-review' : 'pass';
      decision = maxDecision(decision, next);
      rules.push({
        id: rule.id,
        outcome: missing.length ? 'failed' : 'met',
        decision: next,
        reason: missing.length ? `Outstanding checks: ${missing.join(', ')}` : 'All declared checks completed.'
      });
    }

    if (rule.type === 'finding-threshold') {
      const matches = findingMatches(reviewResult, rule);
      const next = matches.length ? rule.status : 'pass';
      decision = maxDecision(decision, next);
      rules.push({
        id: rule.id,
        outcome: matches.length ? 'failed' : 'met',
        decision: next,
        reason: matches.length ? `Matched findings: ${matches.map((item) => item.id).join(', ')}` : 'No finding crossed this threshold.'
      });
    }

    if (rule.type === 'require-evidence' || rule.type === 'require-verification') {
      const field = rule.type === 'require-evidence' ? 'evidence' : 'verification';
      const matches = reviewResult.findings.filter((finding) => !finding[field]?.trim());
      const next = matches.length ? 'needs-review' : 'pass';
      decision = maxDecision(decision, next);
      rules.push({
        id: rule.id,
        outcome: matches.length ? 'failed' : 'met',
        decision: next,
        reason: matches.length ? `Missing ${field}: ${matches.map((item) => item.id).join(', ')}` : `All findings include ${field}.`
      });
    }
  }

  const required = pack.rules.flatMap((rule) => rule.checks ?? []);
  return {
    schemaVersion: 1,
    policy: { id: pack.id, version: pack.version },
    review: { caseId: reviewResult.caseId, specialist: reviewResult.specialist },
    decision,
    rules,
    completedChecks: required.filter((id) => completed.has(id)),
    outstandingChecks: required.filter((id) => !completed.has(id)),
    humanReviewRequired: true,
    disclaimer: 'This decision only evaluates declared conditions and does not prove security or compliance.'
  };
}
