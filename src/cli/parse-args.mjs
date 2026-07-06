export function parseArgv(argv) {
  const [, , command = 'list', maybeSkill] = argv;
  return {
    command,
    skillName: maybeSkill && !maybeSkill.startsWith('--') ? maybeSkill : null,
    installAll: argv.includes('--all'),
    dryRun: argv.includes('--dry-run')
  };
}
