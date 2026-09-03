import { parseArgs } from 'node:util';

const COMMAND_OPTIONS = {
  list: {},
  detect: {},
  doctor: {},
  onboard: {},
  install: {
    skill: { type: 'string' },
    all: { type: 'boolean' },
    'dry-run': { type: 'boolean' }
  },
  uninstall: {
    skill: { type: 'string' },
    all: { type: 'boolean' },
    'dry-run': { type: 'boolean' }
  },
  review: {
    skill: { type: 'string' },
    input: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    output: { type: 'string' },
    stdin: { type: 'boolean' },
    yes: { type: 'boolean' },
    policy: { type: 'string' },
    'policy-file': { type: 'string' },
    capsule: { type: 'string' }
  },
  'review-compare': {
    output: { type: 'string' }
  },
  'proof-create': {
    bundle: { type: 'string' },
    'signing-key': { type: 'string' }
  },
  'proof-verify': {
    output: { type: 'string' },
    'allowed-signers': { type: 'string' }
  }
};

const OPTION_FIELDS = {
  skill: 'skillName',
  all: 'installAll',
  'dry-run': 'dryRun',
  input: 'inputPath',
  stdin: 'useStdin',
  provider: 'provider',
  model: 'model',
  output: 'output',
  yes: 'assumeYes',
  policy: 'policyId',
  'policy-file': 'policyFile',
  capsule: 'capsulePath',
  bundle: 'proofBundle',
  'signing-key': 'signingKey',
  'allowed-signers': 'allowedSigners'
};

function parseOptions(args, options) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true, tokens: true });
  } catch (cause) {
    throw new Error(cause.message, { cause });
  }

  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}`);
    seen.add(token.name);
  }
  for (const [name, value] of Object.entries(parsed.values)) {
    if (options[name]?.type === 'string' && value.length === 0) throw new Error(`Option --${name} requires a non-empty value`);
  }
  return parsed;
}

function rejectExtraPositionals(positionals, maximum, context) {
  if (positionals.length > maximum) throw new Error(`Unexpected positional argument for ${context}`);
}

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

  let schema = result.command;
  if (result.command === 'review' && args[0] === 'compare') {
    args.shift();
    schema = 'review-compare';
    result.reviewAction = 'compare';
  } else if (result.command === 'proof') {
    result.proofAction = args[0] && !args[0].startsWith('--') ? args.shift() : null;
    result.proofSource = null;
    result.proofBundle = null;
    result.signingKey = null;
    result.allowedSigners = null;
    result.proofErrors = [];
    schema = `proof-${result.proofAction}`;
  }

  const { values, positionals } = parseOptions(args, COMMAND_OPTIONS[schema] ?? {});
  for (const [option, value] of Object.entries(values)) result[OPTION_FIELDS[option]] = value;

  if (result.command === 'install' || result.command === 'uninstall') {
    rejectExtraPositionals(positionals, 1, result.command);
    if (result.skillName && positionals.length) throw new Error(`Duplicate skill argument for ${result.command}`);
    result.skillName ??= positionals[0] ?? null;
    if (result.installAll && result.skillName) throw new Error(`${result.command} accepts either a skill or --all`);
  } else if (schema === 'review') {
    rejectExtraPositionals(positionals, 1, 'review');
    if (result.skillName && positionals.length) throw new Error('Duplicate skill argument for review');
    result.skillName ??= positionals[0] ?? null;
  } else if (schema === 'review-compare') {
    rejectExtraPositionals(positionals, 2, 'review compare');
    if (positionals.length < 2) throw new Error('review compare requires exactly two capsule paths');
    [result.compareBefore, result.compareAfter] = positionals;
  } else if (result.command === 'proof') {
    rejectExtraPositionals(positionals, 1, `proof ${result.proofAction ?? ''}`.trim());
    result.proofSource = positionals[0] ?? null;
  } else {
    rejectExtraPositionals(positionals, 0, result.command);
  }

  return result;
}
