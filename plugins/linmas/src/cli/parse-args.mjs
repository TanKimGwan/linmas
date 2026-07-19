const VALUE_FLAGS = new Map([
  ['--skill', 'skillName'],
  ['--input', 'inputPath'],
  ['--provider', 'provider'],
  ['--model', 'model'],
  ['--output', 'output'],
  ['--policy', 'policyId'],
  ['--policy-file', 'policyFile'],
  ['--capsule', 'capsulePath']
]);
const PROOF_VALUE_FLAGS = new Map([
  ['--bundle', 'proofBundle'],
  ['--signing-key', 'signingKey'],
  ['--allowed-signers', 'allowedSigners']
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
    policyFile: null,
    capsulePath: null
  };
  const args = argv.slice(2);
  if (args[0] && !args[0].startsWith('--')) result.command = args.shift();
  if (result.command === 'proof') {
    result.proofAction = args.shift() ?? null;
    result.proofSource = args.shift() ?? null;
    result.proofBundle = null;
    result.signingKey = null;
    result.allowedSigners = null;
    result.proofErrors = [];
  }
  if (result.command === 'review' && args[0] === 'compare') {
    args.shift();
    result.reviewAction = 'compare';
    result.compareBefore = args.shift() ?? null;
    result.compareAfter = args.shift() ?? null;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const valueFlags = result.command === 'proof' ? new Map([...VALUE_FLAGS, ...PROOF_VALUE_FLAGS]) : VALUE_FLAGS;
    if (valueFlags.has(arg)) {
      const value = args[++index] ?? null;
      result[valueFlags.get(arg)] = value;
      if (result.command === 'proof' && (!value || value.startsWith('--'))) result.proofErrors.push(`${arg} requires a value`);
    } else if (result.command === 'proof') {
      result.proofErrors.push(arg.startsWith('--') ? `unknown proof option ${arg}` : `unexpected proof argument ${arg}`);
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
