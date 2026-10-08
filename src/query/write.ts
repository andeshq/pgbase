import { sql } from "kysely";
import type { FilterNode, ParsedMutation, PreferOptions, SelectNode } from "../ast.ts";
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
  /** Whether `Prefer: resolution` was actually applied (drives Preference-Applied). */
  resolutionApplied?: boolean;
  /** Primary-key columns for the affected rows, used for `Location`. */
  keys?: Array<Record<string, unknown>>;
}

type Level = QueryLevel;

export async function executeMutation(ctx: WriteContext): Promise<MutationResult> {
  const level = resolveLevel(ctx.schema, ctx.mutation.table);
  assertWritableRelation(level, ctx.mutation.method);
  const result = await (ctx.mutation.method === "POST"
    ? executeInsert(ctx, level)
    : ctx.mutation.method === "PATCH"
      ? executeUpdate(ctx, level)
      : ctx.mutation.method === "PUT"
        ? executeUpsert(ctx, level)
        : executeDelete(ctx, level));

  // PostgREST applies `max-affected` to updates, deletes and RPC calls only,
  // and a singular response must contain exactly one row. Both are checked
  // inside the transaction so a violation rolls the write back.
  if (ctx.mutation.singular && result.count !== 1) {
    throw PgbaseError.notSingular(result.count ?? 0);
  }
  if (ctx.mutation.method === "PATCH" || ctx.mutation.method === "DELETE") {
    assertMaxAffected(ctx.mutation.prefer, result.affected);
  }
  if (ctx.mutation.method === "POST") {
    result.resolutionApplied = resolutionApplies(ctx, level);
  }
  return result;
}

/** `Prefer: max-affected=N` is enforced only with `handling=strict`. */
export function assertMaxAffected(prefer: PreferOptions, affected: number): void {
  if (prefer.maxAffected !== null && prefer.handling === "strict" && affected > prefer.maxAffected) {
    throw PgbaseError.maxAffected(affected);
  }
}

/** Resolution is only applied (and echoed) when a conflict target exists. */
function resolutionApplies(ctx: WriteContext, level: Level): boolean {
  if (ctx.mutation.prefer.resolution === null) return false;
  const target = ctx.mutation.onConflict ?? level.relation.primaryKey;
  return (target?.length ?? 0) > 0;
}

/** True when `resolution=merge-duplicates` will actually be applied. */
function mergeResolutionApplies(ctx: WriteContext, level: Level): boolean {
  return ctx.mutation.prefer.resolution === "merge-duplicates" && resolutionApplies(ctx, level);
}

/** `RETURNING (xmax = 0)` tells an insert apart from a conflict update. */
const INSERTED_EXPRESSION = sql`(xmax = 0)`.as(INSERTED_ALIAS);

/**
 * PostgREST parses array payloads with `json_to_recordset`, so every element
 * must coerce to its column types even when only one of them is applied. This
 * matters for PATCH (the first element wins) and PUT (the element matching the
 * URL wins): an invalid unused element is still a 400.
 */
async function assertRecordsetCoercible(
  ctx: WriteContext,
  level: Level,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const names = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const column = key.trim();
      if (ctx.mutation.columns && !ctx.mutation.columns.includes(column)) continue;
      if (level.relation.columnMap.has(column)) names.add(column);
    }
  }
  if (names.size === 0) return;
  const fields = [...names].map((name) => {
    const column = level.relation.columnMap.get(name)!;
    return sql`${sql.id(name)} ${sql.raw(column.udt)}`;
  });
  await sql`select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as _(${sql.join(fields)})`.execute(ctx.db);
}

/**
 * PUT applies the array element whose primary key matches the URL filters
 * (PostgREST filters the recordset with a WHERE on `pgrst_body`). A single
 * object keeps the permissive URL-identity fallback.
 */
function selectUpsertBody(
  rows: Array<Record<string, unknown>>,
  pk: string[],
  identity: Record<string, unknown>,
): Record<string, unknown> {
  if (rows.length === 1) return rows[0]!;
  const matches = rows.filter((row) =>
    pk.every((column) => {
      const provided = row[column];
      return provided !== undefined && String(provided) === String(identity[column]);
    }),
  );
  if (matches.length > 1) {
    // PostgreSQL rejects `ON CONFLICT DO UPDATE` affecting a row twice.
    throw new PgbaseError(
      "21000",
      "ON CONFLICT DO UPDATE command cannot affect row a second time",
      500,
      null,
      "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.",
    );
  }
  return matches[0] ?? rows[0]!;
}

/** `?columns=` must name real columns, mirroring PostgREST's PGRST204. */
function assertColumnsExist(ctx: WriteContext, level: Level): void {
  if (!ctx.mutation.columns) return;
  for (const column of ctx.mutation.columns) {
    if (!level.relation.columnMap.has(column)) {
      throw PgbaseError.columnNotFound(column, level.relation.name);
    }
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Covers an empty body too: PostgREST reports both as PGRST102.
    throw PgbaseError.invalidBody("Empty or invalid json");
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
      throw PgbaseError.invalidBody();
    }
    // PostgREST rejects bulk arrays whose objects have different keys, unless
    // `?columns=` explicitly selects the fields.
    if (!ctx.mutation.columns && parsed.length > 1) {
      const canonical = Object.keys(parsed[0]!).sort().join("\u0000");
      for (const row of parsed as Array<Record<string, unknown>>) {
        if (Object.keys(row).sort().join("\u0000") !== canonical) throw PgbaseError.invalidBody();
      }
    }
    return parsed as Record<string, unknown>[];
  }
  if (parsed !== null && typeof parsed === "object") {
    return [parsed as Record<string, unknown>];
  }
  // PostgREST truncates any other JSON value to an empty array.
  return [];
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
  assertColumnsExist(ctx, level);
  const bodyRows = await readBodyRows(ctx);
  // An empty JSON array inserts nothing; PostgREST still replies 201 (200 for
  // merge-duplicates) with an empty representation.
  if (bodyRows.length === 0) return shape(ctx, [], undefined, 0);

  const hasNestedBody = bodyRows.some((row) =>
    Object.entries(row).some(([key, value]) => {
      const name = key.trim();
      const hasColumn = level.relation.columnMap.has(name);
      return ctx.schema.tables.has(name) && (!hasColumn || looksLikeNestedValue(value));
    }),
  );
  if (hasNestedBody) {
    assertNestedWriteSupported(ctx, "POST");
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
  const reconciled = bodyRows.map((row) => reconcileRow(ctx, level, row, dropped));
  // `{}` means "insert a row with all defaults". Kysely renders an empty object
  // as `() values ()`, so anchor the insert on the first column with `default`.
  const allEmpty = reconciled.every((row) => Object.keys(row).length === 0);
  const anchor = level.relation.columns[0]?.name;
  const rows = (allEmpty && anchor
    ? reconciled.map(() => ({ [anchor]: DEFAULT }))
    : reconciled
  ).map(renderValues);
  const pk = level.relation.primaryKey;
  const returnKeys = pk ?? level.relation.columns.map((column) => column.name);

  if (wantsRepresentation(ctx) && needsReRead(ctx.mutation.select) && !pk) {
    throw PgbaseError.relationshipEmpty(
      `Cannot return embedded representation for '${level.relation.name}' without a primary key`,
    );
  }

  let qb: any = ctx.db.insertInto(level.name).values(rows);
  const insertColumns = allEmpty ? [] : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  qb = applyConflict(ctx, level, qb, insertColumns);
  const mergeDups = mergeResolutionApplies(ctx, level);
  const insertedFrom = (result: any[]): boolean | undefined =>
    mergeDups ? result.some((row: any) => row[INSERTED_ALIAS] === true) : undefined;

  if (!wantsRepresentation(ctx) && ctx.mutation.prefer.return !== "headers-only") {
    if (!mergeDups) {
      const result = await qb.executeTakeFirst();
      return shape(ctx, [], undefined, affectedRows(result));
    }
    // Count real inserts (`xmax = 0`): an update leaves `xmax` set. This is
    // what makes an all-update merge-duplicates reply 200 instead of 201.
    const result = await qb.returning([INSERTED_EXPRESSION]).execute();
    return shape(ctx, [], undefined, result.length, { inserted: insertedFrom(result) });
  }

  if (!wantsRepresentation(ctx)) {
    if (!pk) {
      if (!mergeDups) {
        const result = await qb.executeTakeFirst();
        return shape(ctx, [], undefined, affectedRows(result));
      }
      const result = await qb.returning([INSERTED_EXPRESSION]).execute();
      return shape(ctx, [], undefined, result.length, { inserted: insertedFrom(result) });
    }
    const result = await qb
      .returning(mergeDups ? [...returnKeys, INSERTED_EXPRESSION] : returnKeys)
      .execute();
    const keys = result.map((row: any) => pick(row, pk));
    return shape(ctx, [], keys, result.length, { inserted: insertedFrom(result) });
  }

  if (needsReRead(ctx.mutation.select)) {
    if (!pk) {
      throw PgbaseError.relationshipEmpty(
        `Cannot return embedded representation for '${level.relation.name}' without a primary key`,
      );
    }
    const insertedRows = await qb
      .returning(mergeDups ? [...returnKeys, INSERTED_EXPRESSION] : returnKeys)
      .execute();
    const keys = insertedRows.map((row: any) => pick(row, pk));
    const responseRows = keys.length > 0 ? await reReadByKeys(ctx, level, keys) : [];
    return shape(ctx, responseRows, keys, insertedRows.length, { inserted: insertedFrom(insertedRows) });
  }

  const selection = mergeDups
    ? [...(returningClause(ctx, level) as any[]), INSERTED_EXPRESSION]
    : (returningClause(ctx, level) as any[]);
  const result = await qb.returning(selection).execute();
  const rowsOut = mergeDups ? result.map((row: any) => stripInserted(row)) : result;
  const keys = pk ? result.map((row: any) => pick(row, pk)) : undefined;
  return shape(ctx, rowsOut, keys, result.length, { inserted: insertedFrom(result) });
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

function hasAllKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] !== undefined);
}

/**
 * Nested writes manage their own child rows, so top-level preferences that
 * reshape a single statement (`columns`, conflict resolution, `missing=default`)
 * do not compose with them. `on_conflict` is only meaningful for the nested PUT
 * parent upsert, so it is allowed there.
 */
function assertNestedWriteSupported(ctx: WriteContext, method: string, allowOnConflict = false): void {
  const unsupported = [
    ctx.mutation.columns ? "`columns`" : null,
    !allowOnConflict && ctx.mutation.onConflict ? "`on_conflict`" : null,
    ctx.mutation.prefer.resolution ? "conflict resolution" : null,
    ctx.mutation.prefer.missing === "default" ? "`missing=default`" : null,
  ].filter((entry): entry is string => entry !== null);
  if (unsupported.length > 0) {
    throw PgbaseError.parse(`Nested ${method} does not support ${unsupported.join(", ")}`);
  }
}

/** Columns actually provided by the caller, without `missing=default` expansion. */
function reconcileProvided(
  ctx: WriteContext,
  level: Level,
  row: Record<string, unknown>,
  dropped: Set<string>,
): Record<string, unknown> {
  const strict = ctx.mutation.prefer.handling === "strict";
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const column = key.trim();
    if (!level.relation.columnMap.has(column)) {
      if (strict) throw PgbaseError.columnNotFound(column, level.relation.name);
      dropped.add(column);
      continue;
    }
    out[column] = row[key];
  }
  return out;
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
      // Many-to-many links live in the junction table, so the parent key is not
      // a column on the related row.
      if (relationship.kind !== "many-to-many") {
        assignForeignKeys(child, relationship.relatedColumns, inserted, relationship.parentColumns);
      }
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

// ---------------------------------------------------------------------------
// Nested updates (PATCH / PUT)
// ---------------------------------------------------------------------------

function nullsFor(columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column, null]));
}

/**
 * Update one related row by primary key. When `link` is given, the row must also
 * be linked to `parent` through the relationship's foreign key, so a nested body
 * can never update a row that belongs to another parent.
 */
async function updateRelatedRow(
  ctx: WriteContext,
  level: Level,
  element: Record<string, unknown>,
  link: { childColumns: string[]; parent: Record<string, unknown>; parentColumns: string[] } | null,
): Promise<void> {
  const pk = requirePrimaryKey(level, `Nested update requires a primary key on '${level.relation.name}'`);
  const changes = reconcileProvided(ctx, level, element, new Set());
  let qb: any = ctx.db.updateTable(level.name).set(renderValues(changes));
  for (const column of pk) qb = qb.where(column, "=", element[column]);
  if (link) {
    link.childColumns.forEach((column, index) => {
      const expected = link.parent[link.parentColumns[index]!];
      const provided = element[column];
      if (provided !== undefined && String(provided) !== String(expected)) {
        throw PgbaseError.parse(
          `Nested update for '${level.relation.name}' cannot move a row to a different parent`,
        );
      }
      qb = qb.where(column, "=", expected);
    });
  }
  const result = await qb.executeTakeFirst();
  if (affectedRows(result) === 0) {
    throw PgbaseError.parse(
      `Nested ${ctx.mutation.method} could not find a related '${level.relation.name}' row for the given key`,
    );
  }
}

async function linkJunctionRow(
  ctx: WriteContext,
  relationship: Extract<Relationship, { kind: "many-to-many" }>,
  parent: Record<string, unknown>,
  related: Record<string, unknown>,
): Promise<void> {
  const junctionRow: Record<string, unknown> = {};
  assignForeignKeys(junctionRow, relationship.junctionParentColumns, parent, relationship.parentColumns);
  assignForeignKeys(junctionRow, relationship.junctionRelatedColumns, related, relationship.relatedColumns);
  await ctx.db
    .insertInto(relationship.junction)
    .values(junctionRow)
    .onConflict((oc: any) => oc.doNothing())
    .executeTakeFirst();
}

/**
 * Apply one nested relation body to a single parent row. Returns the parent FK
 * columns to write when the parent owns the foreign key (many-to-one/one-to-one
 * from the parent side).
 */
async function applyNestedToParent(
  ctx: WriteContext,
  parent: Record<string, unknown>,
  field: NestedBodyField,
  depth: number,
): Promise<Record<string, unknown>> {
  const relationship = field.relationship;
  const relatedLevel = resolveLevel(ctx.schema, field.relation.name);
  const parentChanges: Record<string, unknown> = {};

  if (relationship.kind === "one" && field.parentOwnsForeignKey) {
    if (field.value === null) {
      assignForeignKeys(parentChanges, relationship.parentColumns, nullsFor(relationship.relatedColumns), relationship.relatedColumns);
      return parentChanges;
    }
    const element = field.value as Record<string, unknown>;
    const relatedPk = relatedLevel.relation.primaryKey;
    if (relatedPk && hasAllKeys(element, relatedPk)) {
      await updateRelatedRow(ctx, relatedLevel, element, null);
      assignForeignKeys(parentChanges, relationship.parentColumns, element, relationship.relatedColumns);
    } else {
      const inserted = await insertNestedRow(ctx, relatedLevel, element, relationship.relatedColumns, depth + 1);
      assignForeignKeys(parentChanges, relationship.parentColumns, inserted, relationship.relatedColumns);
    }
    return parentChanges;
  }

  if (relationship.kind === "one") {
    if (field.value === null) return parentChanges;
    const element = field.value as Record<string, unknown>;
    const relatedPk = relatedLevel.relation.primaryKey;
    if (relatedPk && hasAllKeys(element, relatedPk)) {
      await updateRelatedRow(ctx, relatedLevel, element, {
        childColumns: relationship.relatedColumns,
        parent,
        parentColumns: relationship.parentColumns,
      });
    } else {
      const child = { ...element };
      assignForeignKeys(child, relationship.relatedColumns, parent, relationship.parentColumns);
      await insertNestedRow(ctx, relatedLevel, child, [], depth + 1);
    }
    return parentChanges;
  }

  for (const element of field.value as Array<Record<string, unknown>>) {
    const relatedPk = relatedLevel.relation.primaryKey;
    if (relatedPk && hasAllKeys(element, relatedPk)) {
      if (relationship.kind === "many-to-many") {
        await updateRelatedRow(ctx, relatedLevel, element, null);
        await linkJunctionRow(ctx, relationship, parent, element);
      } else {
        await updateRelatedRow(ctx, relatedLevel, element, {
          childColumns: relationship.relatedColumns,
          parent,
          parentColumns: relationship.parentColumns,
        });
      }
    } else {
      const child = { ...element };
      if (relationship.kind !== "many-to-many") {
        assignForeignKeys(child, relationship.relatedColumns, parent, relationship.parentColumns);
      }
      const relatedRow = await insertNestedRow(
        ctx,
        relatedLevel,
        child,
        relationship.kind === "many-to-many" ? relationship.relatedColumns : [],
        depth + 1,
      );
      if (relationship.kind === "many-to-many") {
        await linkJunctionRow(ctx, relationship, parent, relatedRow);
      }
    }
  }
  return parentChanges;
}

/** Apply every nested field to every matched parent row, then update parent FKs. */
async function applyNestedWrites(
  ctx: WriteContext,
  level: Level,
  parentRows: Array<Record<string, unknown>>,
  parentKeyColumns: string[],
  nested: NestedBodyField[],
  scalarChanges: Record<string, unknown>,
): Promise<void> {
  for (const parent of parentRows) {
    const parentChanges = { ...scalarChanges };
    for (const field of nested) {
      Object.assign(parentChanges, await applyNestedToParent(ctx, parent, field, 0));
    }
    if (Object.keys(parentChanges).length === 0) continue;
    let update: any = ctx.db.updateTable(level.name).set(renderValues(parentChanges));
    for (const column of parentKeyColumns) update = update.where(column, "=", parent[column]);
    await update.executeTakeFirst();
  }
}

async function updateNested(
  ctx: WriteContext,
  level: Level,
  scalarBody: Record<string, unknown>,
  nested: NestedBodyField[],
  filters: FilterNode[],
): Promise<MutationResult> {
  assertNestedWriteSupported(ctx, ctx.mutation.method);
  assertFilteredForWrite(level, filters, ctx.mutation.method, ctx.allowUnfilteredViewWrites);
  const pk = requirePrimaryKey(level, `Nested ${ctx.mutation.method} requires a primary key on the parent relation`);

  const parentColumns = new Set(pk);
  for (const field of nested) field.relationship.parentColumns.forEach((column) => parentColumns.add(column));
  const parentRows: Array<Record<string, unknown>> = await applyFilters(
    level,
    ctx.db.selectFrom(level.name).select([...parentColumns]),
    filters,
  ).execute();
  if (parentRows.length === 0) return shape(ctx, [], undefined, 0);

  const scalarChanges = reconcileProvided(ctx, level, scalarBody, new Set());
  await applyNestedWrites(ctx, level, parentRows, pk, nested, scalarChanges);

  const keys = parentRows.map((row) => pick(row, pk));
  const rows = wantsRepresentation(ctx) ? await reReadByKeys(ctx, level, keys) : [];
  return shape(ctx, rows, keys, parentRows.length);
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
  assertColumnsExist(ctx, level);
  const bodyRows = await readBodyRows(ctx);
  // `{}`, `[]` and `[{}]` are all no-op patches in PostgREST.
  if (bodyRows.length === 0) return shape(ctx, [], undefined, 0);
  // PostgREST parses the whole array with `json_to_recordset`; extra elements
  // are not applied but must still coerce (the first element wins).
  if (bodyRows.length > 1) await assertRecordsetCoercible(ctx, level, bodyRows);
  const dropped = new Set<string>();
  const { row: body, nested } = splitNestedBody(ctx, level, bodyRows[0]!, dropped);
  const filters = ctx.mutation.filters;

  if (nested.length > 0) return updateNested(ctx, level, body, nested, filters);

  const changes = reconcileRow(ctx, level, body, dropped);

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
  if (ctx.mutation.rangeLimited) throw PgbaseError.putLimitNotAllowed();

  // PUT filters must be exactly the primary-key columns with `eq`, and the
  // payload must agree with them (PostgREST PGRST105/PGRST115).
  const pk = assertPutFilters(ctx, level);

  const bodyRows = await readBodyRows(ctx);
  if (bodyRows.length === 0) throw PgbaseError.putMatchingPk();
  const target = ctx.mutation.onConflict ?? pk;

  // Identity comes from the query-string filters; body values win where present.
  const identity: Record<string, unknown> = {};
  for (const eq of equalityFilters(ctx.mutation.filters)) identity[eq.column] = eq.value;

  if (bodyRows.length > 1) await assertRecordsetCoercible(ctx, level, bodyRows);
  const body = selectUpsertBody(bodyRows, pk, identity);

  const dropped = new Set<string>();
  const { row: reconciled, nested } = splitNestedBody(ctx, level, body, dropped);
  const hasNested = nested.length > 0;
  if (hasNested) assertNestedWriteSupported(ctx, "PUT", true);

  const changes = reconcileRow(ctx, level, reconciled, dropped);

  const provided: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) provided[key.trim()] = value;
  for (const column of pk) {
    if (provided[column] !== undefined && String(provided[column]) !== String(identity[column])) {
      throw PgbaseError.putMatchingPk();
    }
  }

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

  if (!wantsRepresentation(ctx) && ctx.mutation.prefer.return !== "headers-only") {
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

  if (hasNested) {
    const result = await qb.returning(returnKeysAndInserted).execute();
    const inserted = result.length > 0 ? result[0][INSERTED_ALIAS] === true : false;
    const keys = result.map((row: any) => pick(row, pk));
    if (keys.length > 0) await applyNestedWrites(ctx, level, keys, pk, nested, {});
    const rows = wantsRepresentation(ctx) ? await reReadByKeys(ctx, level, keys, pk) : [];
    return shape(ctx, rows, keys, keys.length, { inserted });
  }

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

function applyConflict(ctx: WriteContext, level: Level, qb: any, insertColumns: string[]): any {
  const resolution = ctx.mutation.prefer.resolution;
  if (!resolution) return qb;
  // Without a primary key or `on_conflict` there is no conflict target, so
  // PostgREST ignores the resolution preference entirely.
  const target = ctx.mutation.onConflict ?? level.relation.primaryKey;
  if (!target || target.length === 0) return qb;
  return qb.onConflict((oc: any) => {
    const builder = oc.columns(target);
    if (resolution === "ignore-duplicates") return builder.doNothing();
    // `doUpdateSet` needs concrete keys; Kysely iterates them with Object.entries.
    const updates: Record<string, unknown> = {};
    for (const column of insertColumns) {
      updates[column] = sql.raw(`excluded.${quoteIdent(column)}`);
    }
    return Object.keys(updates).length > 0 ? builder.doUpdateSet(updates) : builder.doNothing();
  });
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Validate PUT's URL filters: exactly the primary-key columns with `eq`. */
function assertPutFilters(ctx: WriteContext, level: Level): string[] {
  const pk = level.relation.primaryKey;
  if (!pk || pk.length === 0) throw PgbaseError.invalidFilters();
  const filtered = new Set<string>();
  for (const filter of ctx.mutation.filters) {
    if (
      filter.kind !== "op" ||
      filter.op !== "eq" ||
      filter.negate ||
      (filter.jsonPath?.length ?? 0) > 0
    ) {
      throw PgbaseError.invalidFilters();
    }
    filtered.add(filter.column);
  }
  const pkSet = new Set(pk);
  if (filtered.size !== pkSet.size || [...filtered].some((column) => !pkSet.has(column))) {
    throw PgbaseError.invalidFilters();
  }
  return pk;
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
