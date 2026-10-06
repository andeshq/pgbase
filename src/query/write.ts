import { sql } from "kysely";
import type { FilterNode, ParsedMutation, SelectNode } from "../ast.ts";
import { PgbaseError, DEFAULT } from "../errors.ts";
import { buildSelectionList, resolveLevel, type ExecContext } from "./compile.ts";
import { renderFilter, type QueryLevel } from "./filters.ts";
import { resolveRelationship, type Relationship } from "../schema/index.ts";
import type { PgbaseRelation } from "../types.ts";
import { INSERTED_ALIAS, keyAlias, KEY_PREFIX, AFFECTED_ALIAS } from "./aliases.ts";

export interface WriteContext extends ExecContext {
  mutation: ParsedMutation;
  bodyText: string;
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
  assertWritableRelation(level, ctx.mutation.method);
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

function assertWritableRelation(level: Level, method: string): void {
  if (level.relation.kind === "materialized_view") {
    throw PgbaseError.relationNotWritable(level.relation.name, method);
  }
  if (level.relation.kind !== "view") return;

  // PostgreSQL views support INSERT/UPDATE/DELETE independently. ON CONFLICT
  // (pgbase's PUT semantics) requires a real table/index and is never valid on
  // a view, even when the view is otherwise auto-updatable.
  const writable = method === "POST"
    ? level.relation.insertable
    : method === "PATCH"
      ? level.relation.updatable
      : method === "DELETE"
        ? level.relation.deletable
        : false;
  if (!writable) throw PgbaseError.relationNotWritable(level.relation.name, method);
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

async function readBodyRows(ctx: WriteContext): Promise<Record<string, unknown>[]> {
  const text = ctx.bodyText;
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

function requirePrimaryKey(level: Level, message = "Cannot embed: relation has no primary key"): string[] {
  const pk = level.relation.primaryKey;
  if (!pk || pk.length === 0) throw PgbaseError.relationshipEmpty(message);
  return pk;
}

async function reReadByKeys(
  ctx: WriteContext,
  level: Level,
  keys: any[],
  keyColumns: string[] = requirePrimaryKey(level),
): Promise<any[]> {
  return ctx.db
    .selectFrom(level.name)
    .select(returningClause(ctx, level) as any)
    .where((eb: any) => eb.or(keys.map((key: any) => eb.and(keyColumns.map((column) => eb(column, "=", key[column]))))))
    .execute();
}

async function selectKeys(ctx: WriteContext, level: Level, filters: FilterNode[]): Promise<any[]> {
  const pk = requirePrimaryKey(level);
  return applyFilters(level, ctx.db.selectFrom(level.name).select(pk), filters).execute();
}

/** Reject unfiltered PATCH/DELETE unless an updatable view is explicitly opted in. */
function assertFilteredForWrite(
  level: Level,
  filters: FilterNode[],
  method: string,
  allowUnfilteredViewWrites: boolean,
): void {
  const isView = level.relation.kind === "view";
  if (filters.length === 0 && !(isView && allowUnfilteredViewWrites)) {
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

function affectedRows(result: any): number {
  const count = result?.numInsertedOrUpdatedRows ?? result?.numUpdatedRows ?? result?.numDeletedRows;
  return Number(count ?? 0);
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function executeInsert(ctx: WriteContext, level: Level): Promise<MutationResult> {
  const bodyRows = await readBodyRows(ctx);
  if (bodyRows.length === 0) throw PgbaseError.parse("The request body is empty");

  const hasNestedBody = bodyRows.some((row) =>
    Object.entries(row).some(([key, value]) => {
      const name = key.trim();
      const hasColumn = level.relation.columnMap.has(name);
      return ctx.schema.tables.has(name) && (!hasColumn || looksLikeNestedValue(value));
    }),
  );
  if (hasNestedBody) {
    if (ctx.mutation.columns || ctx.mutation.onConflict || ctx.mutation.prefer.resolution) {
      throw PgbaseError.parse("Nested POST does not support `columns`, `on_conflict`, or conflict resolution");
    }
    const pk = requirePrimaryKey(level, "Nested POST requires a primary key on the parent relation");
    const keys: Array<Record<string, unknown>> = [];
    for (const row of bodyRows) {
      const inserted = await insertNestedRow(ctx, level, row, pk, 0);
      keys.push(pick(inserted, pk));
    }
    const responseRows = wantsRepresentation(ctx) ? await reReadByKeys(ctx, level, keys) : [];
    return shape(ctx, responseRows, keys, keys.length);
  }

  const dropped = new Set<string>();
  const rows = bodyRows.map((row) => renderValues(reconcileRow(ctx, level, row, dropped)));
  const pk = level.relation.primaryKey;
  const returnKeys = pk ?? level.relation.columns.map((column) => column.name);

  if (wantsRepresentation(ctx) && needsReRead(ctx.mutation.select) && !pk) {
    throw PgbaseError.relationshipEmpty(
      `Cannot return embedded representation for '${level.relation.name}' without a primary key`,
    );
  }

  let qb: any = ctx.db.insertInto(level.name).values(rows);
  qb = applyConflict(ctx, qb);

  if (!wantsRepresentation(ctx) && ctx.mutation.prefer.return === "minimal") {
    const result = await qb.executeTakeFirst();
    return shape(ctx, [], undefined, affectedRows(result));
  }

  if (!wantsRepresentation(ctx)) {
    if (!pk) {
      const result = await qb.executeTakeFirst();
      return shape(ctx, [], undefined, affectedRows(result));
    }
    const result = await qb.returning(returnKeys).execute();
    return shape(ctx, [], result, result.length);
  }

  if (needsReRead(ctx.mutation.select)) {
    if (!pk) {
      throw PgbaseError.relationshipEmpty(
        `Cannot return embedded representation for '${level.relation.name}' without a primary key`,
      );
    }
    const inserted = await qb.returning(returnKeys).execute();
    const responseRows = inserted.length > 0 ? await reReadByKeys(ctx, level, inserted) : [];
    return shape(ctx, responseRows, inserted, inserted.length);
  }

  const result = await qb.returning(returningClause(ctx, level)).execute();
  return shape(ctx, result, pk ? result.map((row: any) => pick(row, pk)) : undefined, result.length);
}

interface NestedBodyField {
  relation: PgbaseRelation;
  relationship: Relationship;
  parentOwnsForeignKey: boolean;
  value: unknown;
}

function parentOwnsForeignKey(
  ctx: WriteContext,
  parent: PgbaseRelation,
  related: PgbaseRelation,
  relationship: Relationship,
): boolean {
  return relationship.kind === "one" && ctx.schema.foreignKeys.some((fk) =>
    fk.fromTable === parent.name &&
    fk.toTable === related.name &&
    fk.fromColumns.length === relationship.parentColumns.length &&
    fk.fromColumns.every((column, index) => column === relationship.parentColumns[index]) &&
    fk.toColumns.every((column, index) => column === relationship.relatedColumns[index]),
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeNestedValue(value: unknown): boolean {
  return isJsonObject(value) || (Array.isArray(value) && value.length > 0 && value.every(isJsonObject));
}

function splitNestedBody(
  ctx: WriteContext,
  level: Level,
  body: Record<string, unknown>,
  dropped: Set<string>,
): { row: Record<string, unknown>; nested: NestedBodyField[] } {
  const row: Record<string, unknown> = {};
  const nested: NestedBodyField[] = [];

  for (const [rawName, value] of Object.entries(body)) {
    const name = rawName.trim();
    const hasColumn = level.relation.columnMap.has(name);
    const related = ctx.schema.tables.get(name);
    if (hasColumn && related && looksLikeNestedValue(value)) {
      throw PgbaseError.parse(`Nested body key '${name}' conflicts with a column of the same name`);
    }
    if (hasColumn) {
      row[name] = value;
      continue;
    }

    if (related) {
      const relationship = resolveRelationship(ctx.schema, level.relation, related);
      const parentOwnsFk = parentOwnsForeignKey(ctx, level.relation, related, relationship);
      if (relationship.kind === "one") {
        if (value !== null && !isJsonObject(value)) {
          throw PgbaseError.parse(`Nested to-one relation '${name}' must be a JSON object or null`);
        }
      } else if (!Array.isArray(value) || !value.every(isJsonObject)) {
        throw PgbaseError.parse(`Nested to-many relation '${name}' must be an array of JSON objects`);
      }
      nested.push({ relation: related, relationship, parentOwnsForeignKey: parentOwnsFk, value });
      continue;
    }

    if (ctx.mutation.prefer.handling === "strict") {
      throw PgbaseError.columnNotFound(name, level.relation.name);
    }
    dropped.add(name);
  }

  return { row, nested };
}

function assignForeignKeys(
  row: Record<string, unknown>,
  rowColumns: string[],
  source: Record<string, unknown>,
  sourceColumns: string[],
): void {
  rowColumns.forEach((column, index) => {
    const value = source[sourceColumns[index]!];
    if (value === undefined) {
      throw PgbaseError.parse(`Could not resolve nested relationship column '${sourceColumns[index]}'`);
    }
    const existing = row[column];
    if (existing !== undefined && existing !== DEFAULT && String(existing) !== String(value)) {
      throw PgbaseError.parse(`Nested relationship conflicts with supplied '${column}' value`);
    }
    row[column] = value;
  });
}

/** Insert one row and its nested POST relations within the caller's transaction. */
async function insertNestedRow(
  ctx: WriteContext,
  level: Level,
  body: Record<string, unknown>,
  requiredColumns: string[],
  depth: number,
): Promise<Record<string, unknown>> {
  if (depth > 32) throw PgbaseError.parse("Nested POST exceeds the maximum relation depth of 32");

  const dropped = new Set<string>();
  const { row: inputRow, nested } = splitNestedBody(ctx, level, body, dropped);
  if (nested.length > 0 && ctx.mutation.columns) {
    throw PgbaseError.parse("Nested POST cannot be combined with `columns`");
  }

  // Parent-side foreign keys must be populated before their row is inserted.
  for (const field of nested) {
    if (field.relationship.kind !== "one" || !field.parentOwnsForeignKey) continue;
    if (field.value === null) {
      assignForeignKeys(
        inputRow,
        field.relationship.parentColumns,
        Object.fromEntries(field.relationship.relatedColumns.map((column) => [column, null])),
        field.relationship.relatedColumns,
      );
      continue;
    }
    const relatedLevel = resolveLevel(ctx.schema, field.relation.name);
    const relatedRow = await insertNestedRow(
      ctx,
      relatedLevel,
      field.value as Record<string, unknown>,
      field.relationship.relatedColumns,
      depth + 1,
    );
    assignForeignKeys(inputRow, field.relationship.parentColumns, relatedRow, field.relationship.relatedColumns);
  }

  const row = reconcileRow(ctx, level, inputRow, dropped);
  const returnColumns = new Set(requiredColumns);
  for (const field of nested) {
    if (field.relationship.kind !== "one" || !field.parentOwnsForeignKey) {
      field.relationship.parentColumns.forEach((column) => returnColumns.add(column));
    }
  }

  let insert: any = ctx.db.insertInto(level.name).values(renderValues(row));
  let inserted: Record<string, unknown> | undefined;
  if (returnColumns.size > 0) {
    inserted = await insert.returning([...returnColumns]).executeTakeFirst();
  } else {
    await insert.executeTakeFirst();
    inserted = {};
  }
  if (!inserted) throw PgbaseError.parse(`Nested insert into '${level.relation.name}' did not return a row`);

  // Child rows depend on the now-known parent foreign-key values.
  for (const field of nested) {
    const relationship = field.relationship;
    if (relationship.kind === "one" && field.parentOwnsForeignKey) continue;
    if (relationship.kind === "one" && field.value === null) continue;

    const childBodies = relationship.kind === "one"
      ? [field.value as Record<string, unknown>]
      : field.value as Array<Record<string, unknown>>;
    for (const childBody of childBodies) {
      const child = { ...childBody };
      assignForeignKeys(child, relationship.relatedColumns, inserted, relationship.parentColumns);
      const relatedLevel = resolveLevel(ctx.schema, field.relation.name);
      const relatedRow = await insertNestedRow(
        ctx,
        relatedLevel,
        child,
        relationship.kind === "many-to-many" ? relationship.relatedColumns : [],
        depth + 1,
      );

      if (relationship.kind === "many-to-many") {
        const junctionRow: Record<string, unknown> = {};
        assignForeignKeys(
          junctionRow,
          relationship.junctionParentColumns,
          inserted,
          relationship.parentColumns,
        );
        assignForeignKeys(
          junctionRow,
          relationship.junctionRelatedColumns,
          relatedRow,
          relationship.relatedColumns,
        );
        await ctx.db.insertInto(relationship.junction).values(junctionRow).executeTakeFirst();
      }
    }
  }

  return inserted;
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
  assertFilteredForWrite(level, filters, "PATCH", ctx.allowUnfilteredViewWrites);

  if (!wantsRepresentation(ctx)) {
    const result = await applyFilters(level, ctx.db.updateTable(level.name).set(renderValues(changes)), filters)
      .executeTakeFirst();
    return shape(ctx, [], undefined, affectedRows(result));
  }

  if (wantsRepresentation(ctx) && needsReRead(ctx.mutation.select)) {
    requirePrimaryKey(level, `Cannot return embedded representation for '${level.relation.name}' without a primary key`);
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

  if (ctx.mutation.prefer.return === "minimal") {
    const result = await qb.executeTakeFirst();
    return shape(ctx, [], undefined, affectedRows(result));
  }

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
    const rows = needsReRead(ctx.mutation.select) && keys.length > 0
      ? await reReadByKeys(ctx, level, keys, pk)
      : [];
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
  assertFilteredForWrite(level, filters, "DELETE", ctx.allowUnfilteredViewWrites);

  if (!wantsRepresentation(ctx)) {
    const result = await applyFilters(level, ctx.db.deleteFrom(level.name), filters).executeTakeFirst();
    return shape(ctx, [], undefined, affectedRows(result));
  }

  if (wantsRepresentation(ctx) && needsReRead(ctx.mutation.select)) {
    requirePrimaryKey(level, `Cannot return embedded representation for '${level.relation.name}' without a primary key`);
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
    await del.returning(pk!).execute();
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
