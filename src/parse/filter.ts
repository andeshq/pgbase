import type { FilterNode, OpFilter } from "../ast.ts";
import { PgbError } from "../errors.ts";
import { splitTopLevel, stripParens, unquote } from "./util.ts";

export const SCALAR_OPS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "match",
  "imatch",
  "is",
  "isdistinct",
]);

export const IN_OP = "in";
export const ARRAY_OPS = new Set(["cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj"]);
export const FTS_OPS = new Set(["fts", "plfts", "phfts", "wfts"]);

const OP_ALTERNATION =
  "isdistinct|ilike|imatch|plfts|phfts|wfts|neq|gte|lte|like|eq|gt|lt|match|is|in|cs|cd|ov|sl|sr|nxr|nxl|adj|fts";
const CONDITION_RE = new RegExp(
  `^(.+?)\\.(?:(not)\\.)?(${OP_ALTERNATION})(?:\\(([^)]*)\\))?\\.(.*)$`,
  "s",
);

/**
 * Parse a single condition as it appears inside a logical operator, e.g.
 * `age.gt.20`, `age.not.eq.5`, `and(a.eq.1,b.eq.2)`, `not.or(...)`.
 *
 * Note that in the query string the *key* is the column and the *value* holds
 * `[not.]operator.value`; {@link parseRequest} joins them before calling this.
 */
export function parseCondition(raw: string): FilterNode {
  let s = raw.trim();
  let leadingNegate = false;

  // A negated nested group: `not.and(...)` / `not.or(...)`.
  const negatedLogic = /^not\.(and|or)\(([\s\S]*)\)$/.exec(s);
  if (negatedLogic) {
    leadingNegate = true;
    s = `${negatedLogic[1]}(${negatedLogic[2]})`;
  }

  const logic = /^(and|or)\(([\s\S]*)\)$/.exec(s);
  if (logic) {
    const op = logic[1] as "and" | "or";
    const inside = logic[2] ?? "";
    const children = splitTopLevel(inside, ",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map(parseCondition);
    return { kind: "logic", op, negate: leadingNegate, children };
  }

  const match = CONDITION_RE.exec(s);
  if (!match) throw PgbError.parse(`failed to parse filter (${raw})`, raw);

  let column = match[1]!.trim();
  const negate = match[2] === "not";
  const op = match[3]!;
  const tsConfig = match[4];
  const rawValue = match[5] ?? "";

  let jsonPath: string[] | undefined;
  if (column.includes("->")) {
    const segments = column.split(/->>?/);
    column = unquote(segments[0]!);
    jsonPath = segments.slice(1).map((seg) => unquote(seg));
  } else {
    column = unquote(column);
  }

  if (!SCALAR_OPS.has(op) && op !== IN_OP && !ARRAY_OPS.has(op) && !FTS_OPS.has(op)) {
    throw PgbError.parse(`unknown operator: ${op}`, raw);
  }

  return {
    kind: "op",
    column,
    jsonPath,
    op,
    negate,
    value: parseValue(op, rawValue),
    tsConfig,
  } satisfies OpFilter;
}

function parseValue(op: string, raw: string): unknown {
  const value = raw.trim();

  if (op === "is") {
    const v = value.toLowerCase();
    if (v === "null" || v === "unknown" || v === "true" || v === "false") return v;
    throw PgbError.parse(`unexpected 'is' value: ${value}`);
  }

  if (op === "in") {
    const inside = stripParens(value);
    if (inside.trim() === "") return [];
    return splitTopLevel(inside, ",")
      .map((part) => unquote(part))
      .filter((part) => part.length > 0);
  }

  if (op === "cs" || op === "cd" || op === "ov") {
    if (value.startsWith("{") && value.endsWith("}")) {
      const inside = value.slice(1, -1);
      if (inside.trim() === "") return [];
      return splitTopLevel(inside, ",")
        .map((part) => unquote(part))
        .filter((part) => part.length > 0);
    }
    if (value.startsWith("[") || value.startsWith("{")) {
      try {
        return JSON.parse(value);
      } catch {
        /* fall through */
      }
    }
    return unquote(value);
  }

  return unquote(value);
}

/** Parse a top-level logical param such as `or=(age.gt.20,age.lt.10)`. */
export function parseLogicParam(op: "and" | "or", negate: boolean, value: string): FilterNode {
  const inside = stripParens(value);
  const children = splitTopLevel(inside, ",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseCondition);
  return { kind: "logic", op, negate, children };
}
