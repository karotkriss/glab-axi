import { encode } from "@toon-format/toon";

// ---------------------------------------------------------------------------
// Field-def factories. Each returns a tagged object describing how to extract
// one output column from a raw glab JSON item. `as` overrides the output key.
// ---------------------------------------------------------------------------

export interface FieldDef {
  type: "field";
  key: string;
  as?: string;
}
export interface PluckDef {
  type: "pluck";
  key: string;
  subkey: string;
  as?: string;
}
export interface JoinArrayDef {
  type: "joinArray";
  key: string;
  subkey: string;
  as?: string;
  empty: string;
}
export interface RelativeTimeDef {
  type: "relativeTime";
  key: string;
  as?: string;
}
export interface BoolYesNoDef {
  type: "boolYesNo";
  key: string;
  as?: string;
}
export interface MapEnumDef {
  type: "mapEnum";
  key: string;
  map: Record<string, string>;
  fallback?: string;
  as?: string;
}
export interface LowerDef {
  type: "lower";
  key: string;
  as?: string;
}
export interface CustomDef {
  type: "custom";
  as: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (item: any) => unknown;
}

export type Def =
  | FieldDef
  | PluckDef
  | JoinArrayDef
  | RelativeTimeDef
  | BoolYesNoDef
  | MapEnumDef
  | LowerDef
  | CustomDef;

export function field(key: string, as?: string): FieldDef {
  return { type: "field", key, as };
}
export function pluck(key: string, subkey: string, as?: string): PluckDef {
  return { type: "pluck", key, subkey, as };
}
export function joinArray(
  key: string,
  subkey: string,
  as?: string,
  empty = "none",
): JoinArrayDef {
  return { type: "joinArray", key, subkey, as, empty };
}
export function relativeTime(key: string, as?: string): RelativeTimeDef {
  return { type: "relativeTime", key, as };
}
export function boolYesNo(key: string, as?: string): BoolYesNoDef {
  return { type: "boolYesNo", key, as };
}
export function mapEnum(
  key: string,
  map: Record<string, string>,
  fallback?: string,
  as?: string,
): MapEnumDef {
  return { type: "mapEnum", key, map, fallback, as };
}
export function lower(key: string, as?: string): LowerDef {
  return { type: "lower", key, as };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function custom(as: string, fn: (item: any) => unknown): CustomDef {
  return { type: "custom", as, fn };
}

function outputKey(def: Def): string {
  if (def.type === "custom") return def.as;
  return def.as ?? def.key;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extract(item: any, schema: Def[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of schema) {
    const key = outputKey(def);
    switch (def.type) {
      case "field":
        result[key] = item[def.key] ?? null;
        break;
      case "pluck":
        result[key] = item[def.key]?.[def.subkey] ?? null;
        break;
      case "joinArray": {
        const arr = item[def.key];
        if (Array.isArray(arr) && arr.length > 0) {
          result[key] = arr
            .map((x) => (typeof x === "string" ? x : x[def.subkey]))
            .join(",");
        } else {
          result[key] = def.empty;
        }
        break;
      }
      case "relativeTime":
        result[key] = formatRelativeTime(item[def.key]);
        break;
      case "boolYesNo":
        result[key] = item[def.key] ? "yes" : "no";
        break;
      case "mapEnum": {
        const val = item[def.key];
        if (typeof val === "string" && val !== "" && val in def.map) {
          result[key] = def.map[val];
        } else {
          result[key] = def.fallback ?? val ?? "none";
        }
        break;
      }
      case "lower":
        result[key] =
          typeof item[def.key] === "string"
            ? item[def.key].toLowerCase()
            : item[def.key];
        break;
      case "custom":
        result[key] = def.fn(item);
        break;
    }
  }
  return result;
}

/** Render a labeled list of items as TOON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderList(label: string, items: any[], schema: Def[]): string {
  const extracted = items.map((item) => extract(item, schema));
  return encode({ [label]: extracted });
}

/** Render a single labeled detail object as TOON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderDetail(label: string, item: any, schema: Def[]): string {
  return encode({ [label]: extract(item, schema) });
}

/** Render help suggestions (manual: encode() would inline a primitive array). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

/** Render an error in TOON format. */
export function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
): string {
  const blocks = [encode({ error: message, code })];
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));
  return blocks.join("\n");
}

/** Combine multiple TOON blocks into a single output string, dropping empties. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n");
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "unknown";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  return `${Math.floor(diffMon / 12)}y ago`;
}
