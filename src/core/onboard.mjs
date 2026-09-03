import fs from 'node:fs';
import { toPublicReviewError } from '../review/public-error.mjs';

const CAPABILITY_TIMEOUT_MS = 3000;

export async function inspectCodexCapability(providerRegistry, { timeoutMs = CAPABILITY_TIMEOUT_MS } = {}) {
  const provider = providerRegistry?.get?.('codex');
  if (!provider || typeof provider.detectConfiguration !== 'function' || typeof provider.discoverCapabilities !== 'function') {
    return { status: 'BLOCKED', reason: 'Codex provider capability is unavailable.' };
  }

  try {
    const configuration = provider.detectConfiguration();
    if (configuration?.status !== 'configured') {
      const missing = Array.isArray(configuration?.missingRequirements)
        ? configuration.missingRequirements.filter((item) => typeof item === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(item)).slice(0, 8)
        : [];
      return {
        status: 'BLOCKED',
        reason: missing.length > 0 ? `Missing requirements: ${missing.join(', ')}.` : 'Codex provider configuration is incomplete.'
      };
    }

    const controller = new AbortController();
    const timeoutError = Object.assign(
      new Error('Codex capability check timed out'),
      { failureClass: 'provider-timeout', stage: 'capability-startup', reasonCode: 'CAPABILITY_TIMEOUT', provider: 'codex', transmissionState: 'not-attempted' }
    );
    let timer;
    let capabilities;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
      capabilities = await Promise.race([provider.discoverCapabilities({
        includeModels: false,
        timeoutMs,
        signal: controller.signal
      }), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const authMode = ['chatgpt', 'apiKey', 'not-required'].includes(capabilities?.authMode)
      ? capabilities.authMode
      : null;
    if (!authMode) return { status: 'BLOCKED', reason: 'Codex capability response is invalid.' };
    return { status: 'PASS', reason: `Codex execution is available (${authMode}).` };
  } catch (error) {
    return { status: 'BLOCKED', reason: toPublicReviewError(error).message };
  }
}

export function formatOnboarding(detections, skills, manifests, capability = null, manifestErrors = []) {
  const managedSkills = manifests.flatMap((manifest) => manifest.skills);
  const hostReady = detections.some((detection) => detection.status === 'detected');
  const skillsReady = manifestErrors.length === 0
    && managedSkills.length > 0
    && managedSkills.every((skill) => fs.existsSync(skill.path));
  const lines = [
    'Linmas onboarding:',
    'What Linmas is: defensive security skills for local AI coding hosts.',
    '',
    'Installation readiness:',
    `- Host installation: ${hostReady ? 'PASS' : 'BLOCKED'}`,
    `- Skill installation: ${skillsReady ? 'PASS' : 'BLOCKED'}`,
    '',
    'Execution readiness:',
    `- Codex execution capability: ${capability?.status === 'PASS' ? 'PASS' : 'BLOCKED'}`,
    `  Reason: ${capability?.reason ?? 'Capability was not checked.'}`,
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
