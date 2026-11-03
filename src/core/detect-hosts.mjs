import os from 'node:os';
import { createHostRegistry } from '../hosts/registry.mjs';

export function detectHosts({ env = process.env, homedir = os.homedir(), platform = process.platform, registry = createHostRegistry({ homedir, env }), scope, projectRoot } = {}) {
  const options = { env, platform };
  if (scope !== undefined) Object.assign(options, { scope, projectRoot });
  return [...registry.values()].map((adapter) => adapter.detect(options));
}
