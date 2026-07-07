export function formatOnboarding(detections, skills, manifests) {
  const lines = [
    'Linmas onboarding:',
    'Linmas provides defensive security skills for local AI coding hosts.',
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

  lines.push('', 'Managed installs:');
  for (const manifest of manifests) {
    lines.push(`- ${manifest.host}: ${manifest.skills.map((skill) => skill.name).join(', ') || 'none'}`);
  }

  lines.push('', 'Next steps:', '- open your host and confirm the installed local skills are available', '- run `npx linmas doctor` if something looks wrong', '- run `npx linmas uninstall <skill>` to remove a managed install');
  return `${lines.join('\n')}\n`;
}
