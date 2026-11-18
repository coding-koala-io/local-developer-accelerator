// Keep human-facing attribution out of automated output.
export function brandingAllowed({stdout = process.stdout, env = process.env, argv = process.argv.slice(2)} = {}) {
  return !!stdout.isTTY && !('CI' in env) && env.LDA_QUIET !== '1'
    && !argv.some(arg => ['--json', '--non-interactive'].includes(arg));
}
