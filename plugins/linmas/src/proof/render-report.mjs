export function renderProofReports({ source, receipt }) {
  const markdown = renderMarkdown({ source, receipt });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Linmas Proof Chain</title></head><body><main>${renderHtmlBody({ source, receipt })}</main></body></html>\n`;
  return { markdown, html };
}

function renderMarkdown({ source, receipt }) {
  const lines = [
    '# Linmas Proof Chain',
    '',
    `Source: ${code(source.kind)}`,
    `Source SHA-256: ${code(source.sourceSha256 ?? receipt.subject.sha256)}`,
    `Reviewer: ${safe(source, receipt.reviewer.label)}`,
    `Decided at: ${receipt.decidedAt}`,
    '',
    `## Human disposition: ${receipt.summary.overallDisposition}`,
    '',
    safe(source, receipt.summary.statement),
    '',
    '## Findings',
    ''
  ];
  if (receipt.findings.length === 0) lines.push('No findings were reported by the source.');
  for (const decision of receipt.findings) {
    const detail = source.findings?.find((item) => item.id === decision.id);
    lines.push(`### ${code(decision.id)}${detail?.title ? ` — ${safe(source, detail.title)}` : ''}`, '', `- Disposition: **${decision.disposition}**`, `- Rationale: ${safe(source, decision.rationale)}`);
    if (detail?.severity) lines.push(`- Severity: ${safe(source, detail.severity)}`);
    lines.push('');
  }
  lines.push('## Safety boundary', '', '> Human review remains required.', '', 'This report is an evidence summary. It is not an approval, certification, or proof that the software is secure.', '');
  return `${lines.join('\n')}\n`;
}

function renderHtmlBody({ source, receipt }) {
  const rows = receipt.findings.length === 0
    ? '<p>No findings were reported by the source.</p>'
    : receipt.findings.map((decision) => {
      const detail = source.findings?.find((item) => item.id === decision.id);
      return `<article><h3>${escapeHtml(decision.id)}${detail?.title ? ` — ${escapeHtml(detail.title)}` : ''}</h3><p><strong>Disposition:</strong> ${escapeHtml(decision.disposition)}</p><p><strong>Rationale:</strong> ${escapeHtml(decision.rationale)}</p>${detail?.severity ? `<p><strong>Severity:</strong> ${escapeHtml(detail.severity)}</p>` : ''}</article>`;
    }).join('');
  return `<h1>Linmas Proof Chain</h1><dl><dt>Source</dt><dd>${escapeHtml(source.kind)}</dd><dt>Source SHA-256</dt><dd><code>${escapeHtml(source.sourceSha256 ?? receipt.subject.sha256)}</code></dd><dt>Reviewer</dt><dd>${escapeHtml(receipt.reviewer.label)}</dd><dt>Overall disposition</dt><dd>${escapeHtml(receipt.summary.overallDisposition)}</dd></dl><p>${escapeHtml(receipt.summary.statement)}</p><h2>Findings</h2>${rows}<h2>Safety boundary</h2><blockquote>Human review remains required.</blockquote><p>This report is an evidence summary. It is not an approval, certification, or proof that the software is secure.</p>`;
}

// Every value written into report.md first loses line breaks and control
// characters (including CR, U+2028/2029 and NEL), so no value can start a new
// Markdown line or inject raw HTML outside its own inline position.
function inline(value) { return String(value).replaceAll(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '); }
// Code spans render their content literally; only backticks could close them.
function code(value) { return `\`${inline(value).replaceAll('`', "'")}\``; }
// Free text is rendered inert in Markdown: HTML is entity-escaped, inline syntax
// (links, emphasis, code, strikethrough, tables) is backslash-escaped, and a
// leading block marker (list, rule, setext, indentation) is neutralized for text
// that begins its own line, such as the summary statement.
function safe(_source, value) {
  return inline(value)
    .trimStart()
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll(/[`*_[\]()#!|~]/g, (character) => `\\${character}`)
    .replace(/^[-+=]/, (character) => `\\${character}`)
    .replace(/^(\d+)\./, '$1\\.');
}
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
