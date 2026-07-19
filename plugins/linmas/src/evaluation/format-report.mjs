export function formatEvaluationSummary(report) {
  const failed = report.results.filter((item) => !item.passed);
  const lines = [`${failed.length ? 'Offline evaluation failed' : 'Offline evaluation passed'}: ${report.results.length - failed.length}/${report.results.length} cases`];
  for (const item of failed) for (const failure of item.failures) lines.push(`- ${item.caseId} [${failure.dimension}/${failure.code}] ${failure.message}`);
  return `${lines.join('\n')}\n`;
}

export function formatEvaluationReport(report, { output = 'json' } = {}) {
  return output === 'text' ? formatEvaluationSummary(report) : `${JSON.stringify(report, null, 2)}\n`;
}
