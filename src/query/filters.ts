import { sql, type RawBuilder } from "kysely";
import type { FilterNode, OpFilter } from "../ast.ts";
import { PgbaseError } from "../errors.ts";
import { ARRAY_OPS, FTS_OPS, IN_OP } from "../parse/filter.ts";
import { isValidCast } from "../parse/util.ts";
import type { PgbaseRelation } from "../types.ts";

/** A table (or derived table) being queried, qualified with its alias. */
export interface QueryLevel {
  name: string;
  relation: PgbaseRelation;
  path: string;
}

export const SCALAR_SYMBOLS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
  ilike: "ilike",
  match: "~",
  imatch: "~*",
};

const ARRAY_SYMBOLS: Record<string, string> = {
  cs: "@>",
  cd: "<@",
  ov: "&&",
  sl: "<<",
  sr: ">>",
  nxr: "&<",
  nxl: "&>",
  adj: "-|-",
};

const FTS_FUNCTIONS: Record<string, string> = {
  fts: "to_tsquery",
  plfts: "plainto_tsquery",
  phfts: "phraseto_tsquery",
  wfts: "websearch_to_tsquery",
};

export function assertColumn(relation: PgbaseRelation, column: string): void {
  if (!relation.columnMap.has(column)) throw PgbaseError.columnNotFound(column, relation.name);
}

/** Render a column reference, including optional `->` JSON path and `::cast`. */
export function renderColumn(
  level: QueryLevel,
  column: string,
  jsonPath?: string[],
  cast?: string,
): RawBuilder<any> {
  assertColumn(level.relation, column);
  let expr: RawBuilder<any> = sql`${sql.ref(`${level.name}.${column}`)}`;
  if (jsonPath && jsonPath.length > 0) {
    for (let i = 0; i < jsonPath.length - 1; i++) {
      expr = sql`${expr}->${jsonPath[i]}`;
    }
    expr = sql`${expr}->>${jsonPath.at(-1)}`;
  }
  if (cast) {
    if (!isValidCast(cast)) throw PgbaseError.parse(`invalid cast: ::${cast}`);
    expr = sql`${expr}::${sql.raw(cast)}`;
  }
  return expr;
}

export function renderFilter(filter: FilterNode, level: QueryLevel): RawBuilder<any> {
  if (filter.kind === "logic") {
    if (filter.children.length === 0) return filter.negate ? sql`not true` : sql`true`;
    const separator = filter.op === "and" ? sql` and ` : sql` or `;
    const parts = filter.children.map((child) => renderFilter(child, level));
    const combined = sql`(${sql.join(parts, separator)})`;
    return filter.negate ? sql`not ${combined}` : combined;
  }
  return renderOpFilter(filter, level);
}

function renderOpFilter(filter: OpFilter, level: QueryLevel): RawBuilder<any> {
  const lhs = renderColumn(level, filter.column, filter.jsonPath, filter.cast);

  if (filter.op === "is") {
    const value = String(filter.value);
    if (value === "null" || value === "unknown") {
      return filter.negate ? sql`${lhs} is not null` : sql`${lhs} is null`;
    }
    const literal = value === "true" ? sql`true` : sql`false`;
    const expr = sql`${lhs} is ${literal}`;
    return filter.negate ? sql`not (${expr})` : expr;
  }

  if (filter.op === IN_OP) {
    const values = filter.value as unknown[];
    if (values.length === 0) return filter.negate ? sql`true` : sql`false`;
    const expr = sql`${lhs} in (${sql.join(values)})`;
    return filter.negate ? sql`not (${expr})` : expr;
  }

  if (filter.op === "isdistinct") {
    const expr = sql`${lhs} is distinct from ${filter.value}`;
    return filter.negate ? sql`not (${expr})` : expr;
  }

  if (ARRAY_OPS.has(filter.op)) {
    const udt = level.relation.columnMap.get(filter.column)?.udt ?? "text";
    const expr = sql`${lhs} ${sql.raw(ARRAY_SYMBOLS[filter.op]!)} ${bindArray(filter.value, udt)}`;
    return filter.negate ? sql`not (${expr})` : expr;
  }

  if (FTS_OPS.has(filter.op)) {
    const fn = FTS_FUNCTIONS[filter.op]!;
    const call = filter.tsConfig
      ? sql`${sql.raw(fn)}(${filter.tsConfig}, ${filter.value})`
      : sql`${sql.raw(fn)}(${filter.value})`;
    const expr = sql`${lhs} @@ ${call}`;
    return filter.negate ? sql`not (${expr})` : expr;
  }

  // PostgREST treats `*` as an alias for `%` in like/ilike patterns.
  if (filter.op === "like" || filter.op === "ilike") {
    const pattern = String(filter.value).replace(/\*/g, "%");
    const expr = sql`${lhs} ${sql.raw(SCALAR_SYMBOLS[filter.op]!)} ${pattern}`;
    return filter.negate ? sql`not (${expr})` : expr;
  }

  const symbol = SCALAR_SYMBOLS[filter.op];
  if (!symbol) throw PgbaseError.parse(`unsupported operator: ${filter.op}`);
  const expr = sql`${lhs} ${sql.raw(symbol)} ${filter.value}`;
  return filter.negate ? sql`not (${expr})` : expr;
}

function bindArray(value: unknown, udt: string): RawBuilder<any> {
  if (udt.startsWith("_")) {
    const array = Array.isArray(value) ? value : [value];
    return sql`${array}::${sql.raw(udt)}`;
  }
  if (udt === "jsonb" || udt === "json") {
    return sql`${JSON.stringify(value)}::${sql.raw(udt)}`;
  }
  return sql`${value}::${sql.raw(udt)}`;
}
