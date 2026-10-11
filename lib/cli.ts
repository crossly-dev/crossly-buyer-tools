/**
 * Argument parsing and token handling shared by the four tools.
 *
 * Deliberately not a CLI framework: `--key value` pairs, bare `--flag`s and
 * positionals, nothing else, so the tools stay readable top to bottom.
 */

/** A flag's value: the next argument, or `true` when it was given bare. */
export type FlagValue = string | true;

export interface ParsedArgs {
  /** Positional arguments, in order. `_[0]` is the command. */
  _: string[];
  /** `--key value` and bare `--flag` options. */
  flags: Partial<Record<string, FlagValue>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

/** A flag as text, or undefined when absent. A bare `--flag` reads as "true". */
export function text(v: FlagValue | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

/** Dollars on the command line to integer cents on the wire. */
export function dollarsToCents(v: FlagValue | undefined): number {
  return Math.round(Number(v) * 100);
}

/**
 * Read `CROSSLY_TOKEN`, or print why it is needed and exit 2.
 *
 * Each tool passes its own lines, because what the token needs differs:
 * autobuy needs the `buyer:checkout:write` scope, the others do not.
 */
export function requireToken(lines: readonly string[]): string {
  const token = process.env.CROSSLY_TOKEN;
  if (!token) {
    for (const line of lines) console.error(line);
    process.exit(2);
  }
  return token;
}
