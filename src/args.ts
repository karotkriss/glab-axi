import { AxiError } from "./errors.js";

/** True if the flag (--name or --name=value) is present. */
export function hasFlag(args: string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}

/** Read a flag value: supports "--name value" and "--name=value". */
export function getFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      return next;
    }
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

/**
 * Read a flag value AND remove it (and its value) from the args array in place.
 * Used when a value must be consumed so it is not re-parsed as a positional.
 */
export function takeFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.splice(i, 1);
        return undefined;
      }
      args.splice(i, 2);
      return next;
    }
    if (a.startsWith(`${name}=`)) {
      args.splice(i, 1);
      return a.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Remove a boolean flag if present; return whether it was there. */
export function takeBoolFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx >= 0) {
    args.splice(idx, 1);
    return true;
  }
  return false;
}

/** Nth non-flag positional (0-based). Subcommand is usually positional 0. */
export function getPositional(args: string[], n: number): string | undefined {
  const positionals = args.filter((a) => !a.startsWith("-"));
  return positionals[n];
}

/** Parse a required positive integer (issue/MR IID, pipeline id, etc). */
export function requireNumber(raw: string | undefined, label: string): number {
  if (raw === undefined || raw === "") {
    throw new AxiError(`${label} number is required`, "VALIDATION_ERROR");
  }
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0 || String(n) !== raw.replace(/^0+(?=\d)/, "")) {
    throw new AxiError(`invalid ${label} number: ${raw}`, "VALIDATION_ERROR");
  }
  return n;
}
