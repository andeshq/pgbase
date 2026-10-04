import { sql } from "kysely";
import type { FilterNode, ParsedMutation, SelectNode } from "../ast.ts";
import { PgbaseError, DEFAULT } from "../errors.ts";
import { buildSelectionList, resolveLevel, type ExecContext } from "./compile.ts";
import { renderFilter, type QueryLevel } from "./filters.ts";
import { INSERTED_ALIAS, keyAlias, KEY_PREFIX, AFFECTED_ALIAS } from "./aliases.ts";

export interface WriteContext extends ExecContext {
  mutation: ParsedMutation;
}

export interface MutationResult {
  /** Full response rows (only when representation is requested). */
  rows: any[];
  count: number | null;
  /** Rows affected, reported in `Content-Range`. */
  affected: number;
  /** Whether a PUT inserted a new row (drives 201 vs 200). */
  inserted?: boolean;
  /** Primary-key columns for the affected rows, used for `Location`. */
  keys?: Array<Record<string, unknown>>;
}

type Level = QueryLevel;

export async function executeMutation(ctx: WriteContext): Promise<MutationResult> {
  const level = resolveLevel(ctx.schema, ctx.mutation.table);
  switch (ctx.mutation.method) {
    case "POST":
      return executeInsert(ctx, level);
    case "PATCH":
      return executeUpdate(ctx, level);
    case "PUT":
      return executeUpsert(ctx, level);
    case "DELETE":
      return executeDelete(ctx, level);
  }
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

async function readBodyRows(ctx: WriteContext): Promise<Record<string, unknown>[]> {
  if (!ctx.raw) throw PgbaseError.parse("Missing request body");
  const text = await ctx.raw.clone().text();
  if (text.length > ctx.maxBodyBytes) throw PgbaseError.bodyTooLarge(ctx.maxBodyBytes);
  if (text.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw PgbaseError.parse("Failed to parse the request body as JSON");
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
      throw PgbaseError.parse("Every element of the JSON array body must be an object");
    }
    return parsed as Record<string, unknown>[];
  }
  if (parsed !== null && typeof parsed === "object") {
    return [parsed as Record<string, unknown>];
  }
  throw PgbaseError.parse("The request body must be a JSON object or an array of objects");
}

// ---------------------------------------------------------------------------
// Row reconciliation
// ---------------------------------------------------------------------------

function reconcileRow(
  ctx: WriteContext,
  level: Level,
  row: Record<string, unknown>,
  dropped: Set<string>,
): Record<string, unknown> {
  const strict = ctx.mutation.prefer.handling === "strict";
  const missingDefault = ctx.mutation.prefer.missing === "default";
  const columns = ctx.mutation.columns;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(row)) {
    const column = key.trim();
    if (!level.relation.columnMap.has(column)) {
      if (strict) throw PgbaseError.columnNotFound(column, level.relation.name);
      dropped.add(column);
      continue;
    }
    if (columns && !columns.includes(column)) {
      dropped.add(column);
      continue;
    }
    out[column] = row[key];
  }

  if (missingDefault) {
    for (const column of level.relation.columns) {
      if (out[column.name] !== undefined) continue;
      if (columns && !columns.includes(column.name)) continue;
      out[column.name] = DEFAULT;
    }
  }

  return out;
}

function renderValues(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value === DEFAULT ? sql`default` : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

function returningClause(ctx: WriteContext, level: Level): unknown {
  return buildSelectionList(ctx, level, ctx.mutation.select);
}

function wantsRepresentation(ctx: WriteContext): boolean {
  if (ctx.mutation.prefer.return !== "representation") return false;
  return ctx.mutation.method === "DELETE" ? ctx.mutation.select.length > 0 : true;
}

/** `RETURNING` cannot express correlated JSON embeds; those need a re-read. */
function needsReRead(nodes: SelectNode[]): boolean {
  return nodes.some((node) => node.kind === "embed" || (node.kind === "column" && !!node.jsonPath?.length));
}

function applyFilters(level: Level, qb: any, filters: FilterNode[]): any {
  for (const filter of filters) qb = qb.where(renderFilter(filter, level));
  return qb;
}

function primaryKeyPredicate(level: Level, keys: any[]): any {
  const pk = requirePrimaryKey(level);
  return (eb: any) => eb.or(keys.map((key: any) => eb.and(pk.map((column) => eb(column, "=", key[column])))));
}

function requirePrimaryKey(level: Level): string[] {
  const pk = level.relation.primaryKey;
  if (!pk || pk.length === 0) throw PgbaseError.relationshipEmpty("Cannot embed: table has no primary key");
  return pk;
}

async function reReadByKeys(ctx: WriteContext, level: Level, keys: any[]): Promise<any[]> {
  return ctx.db
    .selectFrom(level.name)
    .select(returningClause(ctx, level) as any)
    .where(primaryKeyPredicate(level, keys))
    .execute();
}

async function selectKeys(ctx: WriteContext, level: Level, filters: FilterNode[]): Promise<any[]> {
  const pk = requirePrimaryKey(level);
  return applyFilters(level, ctx.db.selectFrom(level.name).select(pk), filters).execute();
}

/**
 * Reject an unfiltered PATCH/DELETE on a base table (views are exempt: they
 * require INSTEAD OF triggers to be writable and may intentionally sweep).
 */
function assertFilteredForWrite(level: Level, filters: FilterNode[], method: string): void {
  const isView = level.relation.kind === "view" || level.relation.kind === "materialized_view";
  if (filters.length === 0 && !isView) {
    throw PgbaseError.parse(`${method} requires a filter to avoid modifying every row`);
  }
}

/**
 * Build the final {@link MutationResult}. When no representation is wanted the
 * body is dropped but the affected count and keys are kept.
 */
function shape(  ctx: WriteContext,
  rows: any[],
  keys: Array<Record<string, unknown>> | undefined,
  affected: number,
  extra: { inserted?: boolean } = {},
): MutationResult {
  return {
    rows: wantsRepresentation(ctx) ? rows : [],
    affected,
    count: affected,
    keys,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function executeInsert(ctx: WriteContext, level: Level): Promise<MutationResult> {
  const bodyRows = await readBodyRows(ctx);
  if (bodyRows.length === 0) throw PgbaseError.parse("The request body is empty");

  const dropped = new Set<string>();
  const rows = bodyRows.map((row) => renderValues(reconcileRow(ctx, level, row, dropped)));
  const pk = level.relation.primaryKey;
  const returnKeys = pk ?? ["*"];

  let qb: any = ctx.db.insertInto(level.name).values(rows);
  qb = applyConflict(ctx, qb);

  if (!wantsRepresentation(ctx)) {
    const result = await qb.returning(returnKeys).execute();
    return shape(ctx, [], result, result.length);
  }

  if (needsReRead(ctx.mutation.select)) {
    const inserted = await qb.returning(returnKeys).execute();
    const responseRows = inserted.length > 0 ? await reReadByKeys(ctx, level, inserted) : [];
    return shape(ctx, responseRows, inserted, inserted.length);
  }

  const result = await qb.returning(returningClause(ctx, level)).execute();
  return shape(ctx, result, pk ? result.map((row: any) => pick(row, pk)) : undefined, result.length);
}

function pick(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column] = row[column];
  return out;
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

async function executeUpdate(ctx: WriteContext, level: Level): Promise<MutationResult> {
  const bodyRows = await readBodyRows(ctx);
  if (bodyRows.length !== 1) {
    throw PgbaseError.parse("PATCH requires exactly one JSON object in the body");
  }
  const dropped = new Set<string>();
  const changes = reconcileRow(ctx, level, bodyRows[0]!, dropped);
  const filters = ctx.mutation.filters;

  if (Object.keys(changes).length === 0) return shape(ctx, [], undefined, 0);
  assertFilteredForWrite(level, filters, "PATCH");

  if (wantsRepresentation(ctx) && needsReRead(ctx.mutation.select)) {
    const keys = await selectKeys(ctx, level, filters);
    if (keys.length === 0) return shape(ctx, [], undefined, 0);
    let update: any = ctx.db.updateTable(level.name).set(renderValues(changes));
    update = update.where(primaryKeyPredicate(level, keys));
    await update.returning(sql`1`.as(AFFECTED_ALIAS)).execute();
    return shape(ctx, await reReadByKeys(ctx, level, keys), keys, keys.length);
  }

  let qb: any = ctx.db.updateTable(level.name).set(renderValues(changes));
  qb = applyFilters(level, qb, filters);
  qb = qb.returning(withKeyColumns(returningClause(ctx, level) as any[], level));
  const result = await qb.execute();
  const pk = level.relation.primaryKey;
  const keys = pk ? result.map((row: any) => remapKey(row, pk)) : undefined;
  const rows = result.map((row: any) => stripKeyColumns(row, pk));
  return shape(ctx, rows, keys, rows.length);
}

/** Append internal `${KEY_PREFIX}<col>` aliases so callers can build a `Location`. */
function withKeyColumns(selection: any[], level: Level): any[] {
  const pk = level.relation.primaryKey;
  if (!pk || pk.length === 0) return selection;
  return [
    ...selection,
    ...pk.map((column) => sql`${sql.ref(`${level.name}.${column}`)}`.as(keyAlias(column))),
  ];
}

/** Convert the `${KEY_PREFIX}*` aliases back into a plain primary-key object. */
function remapKey(row: Record<string, unknown>, pk: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of pk) out[column] = row[keyAlias(column)];
  return out;
}

/** Remove the internal `${KEY_PREFIX}*` aliases from a representation row. */
function stripKeyColumns(row: Record<string, unknown>, pk: string[] | null): Record<string, unknown> {
  if (!pk || pk.length === 0) return row;
  const keyNames = new Set(pk.map((column) => keyAlias(column)));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!keyNames.has(key)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PUT (upsert)
// ---------------------------------------------------------------------------

async function executeUpsert(ctx: WriteContext, level: Level): Promise<MutationResult> {
  const bodyRows = await readBodyRows(ctx);
  if (bodyRows.length !== 1) {
    throw PgbaseError.parse("PUT requires exactly one JSON object in the body");
  }
  const target = ctx.mutation.onConflict ?? level.relation.primaryKey;
  if (!target || target.length === 0) {
    throw PgbaseError.parse("PUT requires a primary key or `on_conflict` to resolve conflicts");
  }

  const dropped = new Set<string>();
  const changes = reconcileRow(ctx, level, bodyRows[0]!, dropped);

  // Identity comes from the query-string filters; body values win where present.
  const identity: Record<string, unknown> = {};
  for (const eq of equalityFilters(ctx.mutation.filters)) identity[eq.column] = eq.value;

  const insertRow: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) insertRow[key] = renderValues({ [key]: value })[key];
  for (const column of target) {
    if (insertRow[column] === undefined) insertRow[column] = identity[column] ?? DEFAULT;
  }

  const doUpdate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(insertRow)) {
    if (!target.includes(key)) doUpdate[key] = value;
  }

  let qb: any = ctx.db.insertInto(level.name).values(renderValues(insertRow)).onConflict((oc: any) => {
    const builder = oc.columns(target);
    return Object.keys(doUpdate).length > 0 ? builder.doUpdateSet(doUpdate) : builder.doNothing();
  });

  const pk = level.relation.primaryKey ?? target;

  // `xmax = 0` distinguishes a fresh insert from an updated row, and the key
  // aliases give us the primary key for `Location`; both are stripped from the
  // response body. The three cases differ only in what else is selected.
  const returnKeysAndInserted = [
    ...pk.map((c: string) => sql`${sql.ref(c)}`.as(c)),
    sql`(xmax = 0)`.as(INSERTED_ALIAS),
  ];

  if (!wantsRepresentation(ctx) || needsReRead(ctx.mutation.select)) {
    const result = await qb.returning(returnKeysAndInserted).execute();
    const inserted = result.length > 0 ? result[0][INSERTED_ALIAS] === true : false;
    const keys = result.map((row: any) => pick(row, pk));
    const rows = needsReRead(ctx.mutation.select) && keys.length > 0 ? await reReadByKeys(ctx, level, keys) : [];
    return shape(ctx, rows, keys, needsReRead(ctx.mutation.select) ? rows.length : result.length, { inserted });
  }

  const result = await qb
    .returning([
      ...(returningClause(ctx, level) as any[]),
      ...pk.map((c: string) => sql`${sql.ref(`${level.name}.${c}`)}`.as(keyAlias(c))),
      sql`(xmax = 0)`.as(INSERTED_ALIAS),
    ])
    .execute();
  const inserted = result.length > 0 ? result[0][INSERTED_ALIAS] === true : false;
  const keys = result.map((row: any) => remapKey(row, pk));
  const rows = result.map((row: any) => stripKeyColumns(stripInserted(row), pk));
  return shape(ctx, rows, keys, rows.length, { inserted });
}

function stripInserted(row: Record<string, unknown>): Record<string, unknown> {
  if (!(INSERTED_ALIAS in row)) return row;
  const { [INSERTED_ALIAS]: _ignored, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

async function executeDelete(ctx: WriteContext, level: Level): Promise<MutationResult> {
  const filters = ctx.mutation.filters;
  assertFilteredForWrite(level, filters, "DELETE");

  if (wantsRepresentation(ctx) && needsReRead(ctx.mutation.select)) {
    const keys = await selectKeys(ctx, level, filters);
    if (keys.length === 0) return shape(ctx, [], undefined, 0);
    // Read the response rows before deleting them, in the same transaction.
    let readQb: any = ctx.db
      .selectFrom(level.name)
      .select(withKeyColumns(returningClause(ctx, level) as any[], level));
    readQb = applyFilters(level, readQb, filters);
    const readResult = await readQb.execute();
    const pk = level.relation.primaryKey;
    let del: any = ctx.db.deleteFrom(level.name);
    del = applyFilters(level, del, filters);
    await del.returning(pk ?? ["*"]).execute();
    const rows = readResult.map((row: any) => stripKeyColumns(row, pk));
    const keysOut = pk ? readResult.map((row: any) => remapKey(row, pk)) : undefined;
    return shape(ctx, rows, keysOut, rows.length);
  }

  let qb: any = ctx.db.deleteFrom(level.name);
  qb = applyFilters(level, qb, filters);
  qb = qb.returning(withKeyColumns(returningClause(ctx, level) as any[], level));
  const result = await qb.execute();
  const pk = level.relation.primaryKey;
  const keys = pk ? result.map((row: any) => remapKey(row, pk)) : undefined;
  const rows = result.map((row: any) => stripKeyColumns(row, pk));
  return shape(ctx, rows, keys, rows.length);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyConflict(ctx: WriteContext, qb: any): any {
  const resolution = ctx.mutation.prefer.resolution;
  if (!resolution) return qb;
  const target = ctx.mutation.onConflict;
  return qb.onConflict((oc: any) => {
    const builder = target ? oc.columns(target) : oc;
    return resolution === "ignore-duplicates" ? builder.doNothing() : builder.doUpdateSet(excludedProxy);
  });
}

/** `doUpdateSet` needs concrete keys; proxy every column to `excluded.<col>`. */
const excludedProxy = new Proxy(
  {},
  { get: (_t, prop: string) => sql.raw(`excluded.${quoteIdent(String(prop))}`) },
) as Record<string, unknown>;

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function equalityFilters(filters: FilterNode[]): Array<{ column: string; value: unknown }> {
  const out: Array<{ column: string; value: unknown }> = [];
  const visit = (filter: FilterNode) => {
    if (filter.kind === "logic") {
      filter.children.forEach(visit);
      return;
    }
    if (filter.op === "eq" && !filter.negate && !filter.jsonPath) {
      out.push({ column: filter.column, value: filter.value });
    }
  };
  filters.forEach(visit);
  return out;
}
