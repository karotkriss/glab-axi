import { runJq } from "./gl.js";
import { AxiError } from "./errors.js";
import { takeFlag, takeBoolFlag } from "./args.js";

/**
 * Machine-readable escape hatches shared by `api`, `mr list`, and `mr view`:
 * `--json`/`--raw` print the raw GitLab JSON verbatim, `--jq <expr>` runs a jq
 * program over it. Both operate on the raw, unmodified response - not the
 * noise-stripped TOON view the default path renders.
 */
export interface MachineFlags {
  jqExpr?: string;
  raw: boolean;
}

/** Extract --jq/--json/--raw from a subcommand's args (mutating), validating --jq. */
export function takeMachineFlags(args: string[]): MachineFlags {
  const hasJq = args.some((a) => a === "--jq" || a.startsWith("--jq="));
  const jqExpr = takeFlag(args, "--jq");
  if (hasJq && !jqExpr) {
    throw new AxiError(
      "The --jq flag requires an expression, e.g. --jq '.state'",
      "VALIDATION_ERROR",
    );
  }
  // --json and --raw are aliases; --json is the documented spelling.
  const raw = takeBoolFlag(args, "--json") || takeBoolFlag(args, "--raw");
  return { jqExpr, raw };
}

/** Run a jq expression over raw JSON text, mapping jq's failures to AxiErrors. */
export async function applyJq(rawJson: string, expr: string): Promise<string> {
  const jq = await runJq(rawJson, expr);
  if (jq.stderr === "ENOENT") {
    throw new AxiError(
      "jq is not installed - pass --json and pipe to your own jq instead",
      "CLI_NOT_INSTALLED",
    );
  }
  if (jq.exitCode !== 0) {
    const line = jq.stderr.trim().split("\n")[0];
    throw new AxiError(
      line || `jq failed (exit ${jq.exitCode})`,
      "VALIDATION_ERROR",
    );
  }
  return jq.stdout.replace(/\n$/, "");
}

/** Render a raw JSON response per the machine flags: jq filter, else verbatim. */
export async function renderMachine(
  rawJson: string,
  flags: MachineFlags,
): Promise<string> {
  if (flags.jqExpr !== undefined) return applyJq(rawJson, flags.jqExpr);
  return rawJson.trim();
}
