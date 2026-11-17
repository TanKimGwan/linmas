// Usage text for `linmas --help`. Command forms match the README "Command
// reference" table (a test keeps them in step).
export const USAGE_TEXT = `Usage: linmas <command> [options]

Commands:
  list                                    List canonical Linmas skills.
  detect                                  Detect supported installation hosts.
  onboard                                 Inspect host and Codex account capabilities.
  doctor                                  Diagnose managed installations and duplicates.
  install <skill>                         Install one canonical skill; add --dry-run to preflight.
  uninstall <skill>                       Remove a Linmas-managed skill.
  review ...                              Prepare locally (no review is run), or run an explicit
                                          provider review with --provider.
  review compare before.json after.json   Compare two capsules offline.
  proof create <source> --bundle <dir>    Record human decisions and create a portable proof bundle.
  proof verify <dir>                      Verify bundle hashes and optional SSH signature offline.

Options:
  -h, --help       Print this help and exit.
  -v, --version    Print the installed Linmas version and exit.

Without a command, linmas lists the available skills. See README.md for each command's options.
`;
