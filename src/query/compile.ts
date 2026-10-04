import { sql, type RawBuilder } from "kysely";
import { jsonArrayFrom, jsonObjectFrom } from "kysely/helpers/postgres";
import type { FilterNode, OrderTerm, ParsedRequest, SelectEmbed, SelectNode } from "../ast.ts";
import { PgbaseError } from "../errors.ts";
import { resolveRelationship, type Relationship } from "../schema/index.ts";
import type { PgbaseRelation, PgbaseSchema } from "../types.ts";
import { renderColumn, renderFilter, type QueryLevel } from "./filters.ts";

export interface ExecContext {
  db: any;
  schema: PgbaseSchema;
  /** The parsed request AST. Writes and RPCs narrow this to their own shape. */
  request: ParsedRequest;
  /** The original web request, used by writes to read the body. */
  raw?: Request;
  maxRows: number;
  maxBodyBytes: number;
  defaultLimit?: number;
}

/** Everything the read compiler needs except the parsed request itself. */
export type BaseContext = Omit<ExecContext, "request">;

export interface ReadResult {
  rows: any[];
  count: number | null;
}

export async function executeRead(ctx: ExecContext): Promise<ReadResult> {
  const rows = await buildReadQuery(ctx).execute();
  let count: number | null = null;
  if (ctx.request.count) {
    const row = await buildCountQuery(ctx).executeTakeFirst();
    count = row ? Number((row as any).count) : 0;
  }
  return { rows, count };
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/** Resolve the top-level relation for a table name, or throw PGRST205. */
export function resolveLevel(schema: PgbaseSchema, table: string): QueryLevel {
  const relation = schema.tables.get(table);
  if (!relation) throw PgbaseError.tableNotFound(table);
  return { name: relation.name, relation, path: "" };
}

function rootLevel(ctx: ExecContext): QueryLevel {
  return resolveLevel(ctx.schema, ctx.request.table);
}

export function buildReadQuery(ctx: ExecContext): any {
  const level = rootLevel(ctx);
  let qb: any = ctx.db.selectFrom(level.name);
  qb = qb.select(buildSelection(ctx, level, ctx.request.select));
  qb = applyLevelConditions(qb, ctx, level, ctx.request.select, ctx.request.filters);

  for (const term of ctx.request.order) qb = qb.orderBy(renderOrder(term, level));

  let limit = ctx.request.limit;
  if (limit === undefined && ctx.defaultLimit !== undefined) limit = ctx.defaultLimit;
  if (ctx.maxRows !== Infinity) {
    limit = limit === undefined ? ctx.maxRows : Math.min(limit, ctx.maxRows);
  }
  if (limit !== undefined) qb = qb.limit(limit);
  if (ctx.request.offset !== undefined) qb = qb.offset(ctx.request.offset);
  return qb;
}

export function buildCountQuery(ctx: ExecContext): any {
  const level = rootLevel(ctx);
  let qb: any = ctx.db.selectFrom(level.name).select((eb: any) => eb.fn.countAll().as("count"));
  qb = applyLevelConditions(qb, ctx, level, ctx.request.select, ctx.request.filters);
  return qb;
}

function applyLevelConditions(
  qb: any,
  ctx: ExecContext,
  level: QueryLevel,
  nodes: SelectNode[],
  filters: FilterNode[],
): any {
  for (const filter of filters) qb = qb.where(renderFilter(filter, level));
  for (const node of nodes) {
    if (node.kind === "embed" && node.inner) qb = qb.where(renderExistence(ctx, level, node));
  }
  return qb;
}

/** Build the `select` list for a level. Exposed so writes can share it in `returning`. */
export function buildSelectionList(ctx: ExecContext, level: QueryLevel, nodes: SelectNode[]): any[] {
  return buildSelection(ctx, level, nodes);
}

function buildSelection(ctx: ExecContext, level: QueryLevel, nodes: SelectNode[]): any[] {
  const expanded: SelectNode[] =
    nodes.length > 0 ? nodes : [{ kind: "column", column: "*", star: true }];
  const out: any[] = [];
  for (const node of expanded) {
    if (node.kind === "column") {
      if (node.star) {
        for (const column of level.relation.columns) {
          out.push(renderColumn(level, column.name).as(column.name));
        }
      } else {
        const alias = node.alias ?? (node.jsonPath?.length ? node.jsonPath.at(-1)! : node.column);
        out.push(renderColumn(level, node.column, node.jsonPath, node.cast).as(alias));
      }
    } else {
      out.push(buildEmbed(ctx, level, node));
    }
  }
  return out;
}

function buildEmbed(ctx: ExecContext, level: QueryLevel, node: SelectEmbed): any {
  const { sub, childLevel, params, relationship } = makeEmbedBase(ctx, level, node);
  const selected = applyLevelConditions(sub, ctx, childLevel, node.children, params.filters);
  const projected = selected.select(buildSelection(ctx, childLevel, node.children));

  for (const term of params.order) projected.orderBy(renderOrder(term, childLevel));
  if (params.limit !== undefined) projected.limit(params.limit);
  if (params.offset !== undefined) projected.offset(params.offset);

  const wrapper = relationship.kind === "one" ? jsonObjectFrom(projected) : jsonArrayFrom(projected);
  return wrapper.as(node.alias ?? node.relation);
}

function renderExistence(ctx: ExecContext, level: QueryLevel, node: SelectEmbed): RawBuilder<any> {
  const { sub, childLevel, params } = makeEmbedBase(ctx, level, node);
  const filtered = applyLevelConditions(sub, ctx, childLevel, node.children, params.filters);
  return sql`exists (${filtered.select(sql`1`)})`;
}

function makeEmbedBase(
  ctx: ExecContext,
  level: QueryLevel,
  node: SelectEmbed,
): { sub: any; related: PgbaseRelation; childLevel: QueryLevel; params: any; relationship: Relationship } {
  const related = ctx.schema.tables.get(node.relation);
  if (!related) throw PgbaseError.tableNotFound(node.relation);
  const relationship = resolveRelationship(ctx.schema, level.relation, related, node.hint);
  const childPath = level.path ? `${level.path}.${node.path}` : node.path;
  const childLevel: QueryLevel = { name: node.relation, relation: related, path: childPath };
  const params = ctx.request.embeds.get(childPath) ?? { filters: [], order: [] };

  let sub: any = ctx.db.selectFrom(node.relation);
  if (relationship.kind === "one") {
    relationship.parentColumns.forEach((parentColumn, i) => {
      sub = sub.whereRef(`${related.name}.${relationship.relatedColumns[i]}`, "=", `${level.name}.${parentColumn}`);
    });
  } else if (relationship.kind === "many") {
    relationship.relatedColumns.forEach((relatedColumn, i) => {
      sub = sub.whereRef(`${related.name}.${relatedColumn}`, "=", `${level.name}.${relationship.parentColumns[i]}`);
    });
  } else {
    const junction = relationship.junction;
    sub = sub.innerJoin(junction, (join: any) => {
      let builder = join;
      relationship.junctionRelatedColumns.forEach((junctionColumn, i) => {
        builder = builder.onRef(`${junction}.${junctionColumn}`, "=", `${related.name}.${relationship.relatedColumns[i]}`);
      });
      return builder;
    });
    relationship.junctionParentColumns.forEach((junctionColumn, i) => {
      sub = sub.whereRef(`${junction}.${junctionColumn}`, "=", `${level.name}.${relationship.parentColumns[i]}`);
    });
  }

  return { sub, related, childLevel, params, relationship };
}

function renderOrder(term: OrderTerm, level: QueryLevel): RawBuilder<any> {
  const lhs = renderColumn(level, term.column, term.jsonPath, term.cast);
  const direction = sql`${sql.raw(term.direction)}`;
  const nulls =
    term.nulls === "first"
      ? sql` nulls first`
      : term.nulls === "last"
        ? sql` nulls last`
        : sql``;
  return sql`${lhs} ${direction}${nulls}`;
}
