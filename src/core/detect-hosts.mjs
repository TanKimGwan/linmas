import { createHostRegistry } from '../hosts/registry.mjs';

export function detectHosts({ env = process.env, homedir, platform = process.platform, registry = createHostRegistry({ homedir }) } = {}) {
  return [...registry.values()].map((adapter) => adapter.detect({ env, platform }));
}
