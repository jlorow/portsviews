/**
 * The two plain lines printed before the "credential is missing or empty"
 * error, as a pure function: given the path, whether a file exists there,
 * and the variable name that was wanted, it returns the lines to print.
 *
 * It is pure and takes all three as arguments so a test can cover every
 * case -- no file at all, a file with a value, and each variable -- with
 * no real .env anywhere on disk.
 *
 * Two deliberate constraints, both from the story it comes from:
 *  - It never reads, parses or prints the file's contents, and it never
 *    receives a value. The caller passes an fs.existsSync() result, which
 *    is the only filesystem question asked.
 *  - It hardcodes NO variable name and NO path: the caller passes the
 *    same path it handed to dotenv and the variable for the source it
 *    chose, so the hint cannot drift from either.
 */
export function missingKeyLines(
  envPath: string,
  envFileExists: boolean,
  variable: string,
): string[] {
  return [
    `[Wake] Looked for .env at: ${envPath}`,
    envFileExists
      ? `[Wake] That file exists but has no ${variable} line with a value. ` +
        'If you created it with echo, recreate it in a text editor.'
      : '[Wake] No file named .env exists there.',
  ]
}
