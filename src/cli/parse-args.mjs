const VALUE_FLAGS = new Map([
  ['--skill', 'skillName'],
  ['--input', 'inputPath'],
  ['--provider', 'provider'],
  ['--model', 'model'],
  ['--output', 'output'],
  ['--policy', 'policyId'],
  ['--policy-file', 'policyFile']
]);

export function parseArgv(argv) {
  const result = {
    command: 'list',
    skillName: null,
    installAll: false,
    dryRun: false,
    inputPath: null,
    useStdin: false,
    provider: null,
    model: null,
    output: 'text',
    assumeYes: false,
    policyId: null,
    policyFile: null
  };
  const args = argv.slice(2);
  if (args[0] && !args[0].startsWith('--')) result.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      result[VALUE_FLAGS.get(arg)] = args[++index] ?? null;
    } else if (arg === '--all') {
      result.installAll = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--stdin') {
      result.useStdin = true;
    } else if (arg === '--yes') {
      result.assumeYes = true;
    } else if (!arg.startsWith('--') && result.skillName === null) {
      result.skillName = arg;
    }
  }
  return result;
}
