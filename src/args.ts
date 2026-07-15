import { AxiError } from "./errors.js";

function flagEqualsPrefix(flag: string): string {
  return `${flag}=`;
}

/** Get a flag's value from --flag value or --flag=value without modifying args. */
export function getFlag(args: string[], name: string): string | undefined {
  const equalsPrefix = flagEqualsPrefix(name);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      if (i + 1 >= args.length) return undefined;
      return args[i + 1];
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length);
    }
  }
  return undefined;
}

/** Get a flag's value from --flag value or --flag=value and remove it from args. */
export function takeFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = flagEqualsPrefix(flag);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const val = args[i + 1];
      args.splice(i, 2);
      return val;
    }
    if (arg.startsWith(equalsPrefix)) {
      const val = arg.slice(equalsPrefix.length);
      args.splice(i, 1);
      return val;
    }
  }
  return undefined;
}

/** Check if a boolean flag is present. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Check if a boolean flag is present and remove it from args. */
export function takeBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Collect all values for a repeatable flag in --flag value or --flag=value form. */
export function getAllFlags(args: string[], flag: string): string[] {
  const result: string[] = [];
  const equalsPrefix = flagEqualsPrefix(flag);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) {
      result.push(args[i + 1]);
      i++;
    } else if (arg.startsWith(equalsPrefix)) {
      result.push(arg.slice(equalsPrefix.length));
    }
  }
  return result;
}

/** Collect all values for a repeatable flag and remove each matched token from args. */
export function takeAllFlags(args: string[], flag: string): string[] {
  const result: string[] = [];
  const equalsPrefix = flagEqualsPrefix(flag);
  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) {
      result.push(args[i + 1]);
      args.splice(i, 2);
    } else if (arg.startsWith(equalsPrefix)) {
      result.push(arg.slice(equalsPrefix.length));
      args.splice(i, 1);
    } else {
      i++;
    }
  }
  return result;
}

/** Get the first positional arg (non-flag) starting from startIndex. */
export function getPositional(
  args: string[],
  startIndex: number,
): string | undefined {
  for (let i = startIndex; i < args.length; i++) {
    if (!args[i].startsWith("--")) return args[i];
  }
  return undefined;
}

/** Parse and validate a required numeric argument. */
export function requireNumber(raw: string | undefined, label: string): number {
  if (!raw) throw new AxiError(`Missing ${label} number`, "VALIDATION_ERROR");
  const n = parseInt(raw, 10);
  if (isNaN(n))
    throw new AxiError(`Invalid ${label} number: ${raw}`, "VALIDATION_ERROR");
  return n;
}

/** Find the first numeric positional arg, remove it from args, and return it as a number. */
export function takeNumber(args: string[], label: string): number {
  const raw = args.find((a) => /^\d+$/.test(a));
  if (!raw) throw new AxiError(`Missing ${label} number`, "VALIDATION_ERROR");
  args.splice(args.indexOf(raw), 1);
  return Number(raw);
}

/**
 * Parse a --limit value into a safe per_page number.
 * parseInt("abc") yields NaN, which would become per_page=NaN in the query —
 * this helper falls back to the default on any non-positive / non-numeric input.
 */
export function parseLimit(raw: string | undefined, fallback = 30): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return fallback;
  return n;
}

// ---------------------------------------------------------------------------
// Unknown-flag rejection (AXI clause 6)
// ---------------------------------------------------------------------------

/** Flags accepted everywhere, so no per-subcommand help block declares them. */
const UNIVERSAL_FLAGS = new Set(["--help", "-h", "-R", "--repo"]);

/**
 * Pull every flag token out of a help block's prose.
 *
 * The lookbehind is what keeps a hyphenated English word out of the set: in
 * "blocked-by" the `-by` is preceded by a word character, so only a token that
 * genuinely starts a flag matches.
 */
function flagsIn(text: string): string[] {
  return text.match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? [];
}

/** Read an indented block body that follows a `header:` line. */
function blockBody(lines: string[], start: number): string {
  const body: string[] = [];
  for (let i = start; i < lines.length && lines[i].startsWith("  "); i++) {
    body.push(lines[i]);
  }
  return body.join("\n");
}

interface HelpFlags {
  /** Flags every subcommand accepts, from a bare `flags:` block (e.g. search). */
  universal: Set<string> | undefined;
  perSub: Map<string, Set<string>>;
  /** Every subcommand name the help declares, including flag-block aliases. */
  subs: Set<string>;
}

/**
 * Read a command's `subcommands[...]` / `flags{...}` help blocks into the set
 * of flags each subcommand accepts.
 *
 * The help text is the single source of truth. A flag the code reads but the
 * help never declares is now rejected at the boundary rather than silently
 * honoured, so that drift fails loudly instead of rotting undetected.
 */
export function parseHelpFlags(help: string): HelpFlags {
  const lines = help.split("\n");
  const perSub = new Map<string, Set<string>>();
  const subs = new Set<string>();
  let universal: Set<string> | undefined;

  for (let i = 0; i < lines.length; i++) {
    const flagHeader = lines[i].match(/^flags(?:\{(.+)\})?:$/);
    if (flagHeader) {
      const flags = new Set(flagsIn(blockBody(lines, i + 1)));
      if (flagHeader[1] === undefined) {
        universal = flags;
        continue;
      }
      // A subcommand may appear in several blocks (`variable set` takes --env
      // from `flags{get,view,set,delete,rm}` and --value from `flags{set}`), so
      // the sets merge; overwriting would reject a flag the command accepts.
      for (const sub of flagHeader[1].split(",").map((s) => s.trim())) {
        const existing = perSub.get(sub);
        perSub.set(sub, existing ? new Set([...existing, ...flags]) : flags);
        subs.add(sub);
      }
      continue;
    }
    // `types[...]` is search's spelling of the same list.
    if (/^(?:subcommands|types)\[\d+\]:$/.test(lines[i])) {
      for (const entry of blockBody(lines, i + 1).split(",")) {
        const name = entry.trim().split(/\s+/)[0];
        if (name) subs.add(name);
      }
    }
  }
  return { universal, perSub, subs };
}

/**
 * Reject any flag the subcommand does not declare (AXI clause 6).
 *
 * A dropped flag is worse than an error: the agent gets output it believes is
 * filtered and proceeds on wrong data. This runs before the handler, so it
 * lands before any network call - including a mutation that cannot be undone.
 */
export function rejectUnknownFlags(
  help: string,
  domain: string,
  sub: string | undefined,
  args: string[],
): void {
  if (sub === undefined) return;
  const { universal, perSub, subs } = parseHelpFlags(help);
  // An unrecognized subcommand is the router's error to name, not ours.
  if (!subs.has(sub)) return;
  const allowed = universal ?? perSub.get(sub) ?? new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-") || arg === "-") continue;
    const name = arg.split("=", 1)[0];
    if (allowed.has(name) || UNIVERSAL_FLAGS.has(name)) {
      // A known flag's value may itself lead with a dash (--title "-1 regression",
      // --limit -5). Only a single-dash token is claimed as a value, so a real
      // `--flag` following a boolean flag is still inspected, never swallowed.
      // ponytail: an unknown single-dash flag right after a known flag reads as
      // that flag's value; spell it `--flag=value` if that ambiguity ever bites.
      const next = args[index + 1];
      if (
        !arg.includes("=") &&
        next?.startsWith("-") &&
        !next.startsWith("--")
      ) {
        index++;
      }
      continue;
    }
    throw new AxiError(
      `Unknown flag for \`glab-axi ${domain} ${sub}\`: ${name}`,
      "VALIDATION_ERROR",
      unknownFlagSuggestions(
        domain,
        sub,
        name,
        allowed,
        perSub,
        args[index - 1],
      ),
    );
  }
}

function unknownFlagSuggestions(
  domain: string,
  sub: string,
  name: string,
  allowed: Set<string>,
  perSub: Map<string, Set<string>>,
  previous: string | undefined,
): string[] {
  const label = `glab-axi ${domain} ${sub}`;
  const valid = [...allowed].sort();
  const suggestions: string[] = [];

  const nearest = valid.find((f) => f.startsWith(name) || name.startsWith(f));
  if (nearest) suggestions.push(`Did you mean \`${nearest}\`?`);

  const sibling = [...perSub].find(
    ([other, flags]) => other !== sub && flags.has(name),
  );
  if (sibling) {
    suggestions.push(
      `\`${name}\` is a flag of \`glab-axi ${domain} ${sibling[0]}\`, not \`${label}\``,
    );
  }
  if (previous !== undefined && allowed.has(previous)) {
    suggestions.push(
      `If \`${name}\` is a value for \`${previous}\`, pass it as \`${previous}=${name}\``,
    );
  }
  suggestions.push(
    valid.length > 0
      ? `Valid flags for \`${label}\`: ${valid.join(", ")}`
      : `\`${label}\` takes no flags`,
  );
  return suggestions;
}
