export function parseArgv(argv) {
  let command = 'list';
  let skillName = null;
  let seenCommand = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    if (!seenCommand) {
      command = arg;
      seenCommand = true;
      continue;
    }
    if (skillName === null) {
      skillName = arg;
    }
  }

  return {
    command,
    skillName,
    installAll: argv.includes('--all'),
    dryRun: argv.includes('--dry-run')
  };
}
