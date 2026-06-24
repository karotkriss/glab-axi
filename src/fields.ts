import { AxiError } from "./errors.js";
import type { Def } from "./toon.js";

export interface ExtraField {
  jsonKey: string;
  def: Def;
}

export interface ParsedFields {
  extraDefs: Def[];
  extraJsonKeys: string[];
}

/**
 * Parse a --fields a,b,c argument against a map of available extra fields.
 * Throws VALIDATION_ERROR listing valid names when an unknown field is given.
 */
export function parseFields(
  fieldsArg: string | undefined,
  available: Record<string, ExtraField>,
): ParsedFields {
  if (!fieldsArg) return { extraDefs: [], extraJsonKeys: [] };
  const names = [
    ...new Set(
      fieldsArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const extraDefs: Def[] = [];
  const extraJsonKeys: string[] = [];
  for (const name of names) {
    const entry = available[name];
    if (!entry) {
      const valid = Object.keys(available).sort().join(", ");
      throw new AxiError(
        `unknown field "${name}". Available: ${valid}`,
        "VALIDATION_ERROR",
      );
    }
    extraDefs.push(entry.def);
    if (!extraJsonKeys.includes(entry.jsonKey))
      extraJsonKeys.push(entry.jsonKey);
  }
  return { extraDefs, extraJsonKeys };
}
