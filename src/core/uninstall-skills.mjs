import fs from 'node:fs';
import { assertInsideRoot } from './fs-utils.mjs';
import { writeManifest } from './manifest.mjs';

export function planUninstall({ manifests, detections, skillName, uninstallAll }) {
  if (!uninstallAll && !skillName) {
    throw new Error('uninstall requires a skill name or --all');
  }

  const installRoots = new Map(
    detections
      .filter((d) => d.status === 'detected' || d.status === 'probably_detected')
      .map((d) => [d.host, d.installRoot])
  );

  return manifests.flatMap((manifest) => {
    const installRoot = installRoots.get(manifest.host);
    if (!installRoot) return [];

    return manifest.skills
      .filter((skill) => uninstallAll || skill.name === skillName)
      .map((skill) => ({
        host: manifest.host,
        skillName: skill.name,
        skillPath: skill.path,
        installRoot
      }));
  });
}

export function formatUninstallPreview(plan) {
  const lines = ['Linmas uninstall preview:'];
  for (const item of plan) {
    lines.push(`- ${item.host}: remove ${item.skillName} from ${item.skillPath}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function promptForUninstallTarget(io, plan) {
  const hosts = [...new Set(plan.map((item) => item.host))];
  let selectedHosts = [...hosts];

  if (io && typeof io.readLine === 'function' && hosts.length > 1) {
    while (true) {
      io.stdout.write('Choose uninstall target: claude, codex, or both\n');
      const ans = (await io.readLine()).trim().toLowerCase();
      if (ans === 'claude') {
        selectedHosts = ['claude'];
        break;
      }
      if (ans === 'codex') {
        selectedHosts = ['codex'];
        break;
      }
      if (ans === 'both') {
        selectedHosts = [...hosts];
        break;
      }
      io.stdout.write('Invalid uninstall target.\n');
    }
  }

  return selectedHosts;
}

export async function promptForUninstallConfirmation(io) {
  let confirm = false;
  if (io && typeof io.readLine === 'function') {
    io.stdout.write('Confirm uninstallation? [yes/no]\n');
    const ans = (await io.readLine()).trim().toLowerCase();
    if (ans === 'yes' || ans === 'y') confirm = true;
  }
  return confirm;
}

export async function promptForUninstallChoices(io, plan, options = {}) {
  const selectedHosts = await promptForUninstallTarget(io, plan);
  const confirm = await promptForUninstallConfirmation(io);
  return { selectedHosts, confirm };
}

export function applyUninstallPlan(plan, manifests, manifestPathByHost) {
  const removed = [];

  for (const item of plan) {
    assertInsideRoot(item.installRoot, item.skillPath);
    fs.rmSync(item.skillPath, { recursive: true, force: true });
    removed.push(item.skillPath);

    const manifest = manifests.get(item.host);
    if (manifest) {
      const updated = {
        ...manifest,
        skills: manifest.skills.filter((skill) => skill.name !== item.skillName)
      };
      manifests.set(item.host, updated);
      writeManifest(manifestPathByHost.get(item.host), updated);
    }
  }

  return { removed };
}


