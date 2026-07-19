export function formatOnboarding(detections, skills, manifests) {
  const lines = [
    'Linmas onboarding:',
    'What Linmas is: defensive security skills for local AI coding hosts.',
    '',
    'Available skills:'
  ];

  for (const skill of skills) {
    lines.push(`- ${skill.name} — ${skill.description}`);
  }

  lines.push('', 'Detected hosts:');
  for (const detection of detections) {
    lines.push(`- ${detection.host}: ${detection.status} (${detection.installRoot})`);
  }

  lines.push('', 'Installed skills:');
  for (const manifest of manifests) {
    if (manifest.skills.length > 0) {
      for (const skill of manifest.skills) {
        const matchingSkill = skills.find((s) => s.name === skill.name);
        const purpose = matchingSkill ? matchingSkill.description : 'defensive security skill';
        lines.push(`- ${skill.name} on ${manifest.host} — purpose: ${purpose}`);
        lines.push(`  destination paths: ${skill.path}`);
      }
    } else {
      lines.push(`- none on ${manifest.host}`);
    }
  }

  lines.push('', 'Next steps:', '- open your host and confirm the installed local skills are available', '- run `npx linmas doctor` if something looks wrong', '- run `npx linmas uninstall <skill>` to remove a managed install', '- find more docs: README.md');
  return `${lines.join('\n')}\n`;
}
