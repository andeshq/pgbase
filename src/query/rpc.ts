import { sql } from "kysely";
import type { OrderTerm, ParsedRpc } from "../ast.ts";
import { PgbaseError } from "../errors.ts";
import { splitRpcParams } from "../parse/request.ts";
import type { PgbaseFunction, PgbaseRelation } from "../types.ts";
import { buildSelectionList, type ExecContext } from "./compile.ts";
import { renderFilter, type QueryLevel } from "./filters.ts";
import { RPC_ALIAS } from "./aliases.ts";
import { assertMaxAffected } from "./write.ts";

export interface RpcContext extends ExecContext {
  rpc: ParsedRpc;
  /** The introspected function being called. */
  fn: PgbaseFunction;
  /** Index into `rpc.bulkArgs` when executing `Prefer: params=bulk`. */
  rpcIndex?: number;
}

export interface RpcResult {
  rows: any[];
  count: number | null;
  affected: number;
}

interface CallArgs {
  named: Record<string, unknown>;
  positional: unknown[] | null;
}

/**
 * Resolve the call arguments for one invocation.
 *
 * Precedence (matching PostgREST):
 * 1. `Prefer: params=bulk` + JSON array body
 * 2. JSON object body (named args)
 * 3. positional path args (`/rpc/fn/2/1`)
 * 4. query-string args whose key is a declared function argument
 *
 * `GET` may only pass arguments via the query string.
 */
function resolveCall(ctx: RpcContext, body: unknown, method: string): CallArgs {
  if (ctx.rpc.params === "bulk") {
    const element = ctx.rpc.bulkArgs?.[ctx.rpcIndex ?? 0] ?? {};
    return { named: element, positional: null };
  }

  const isGet = method === "GET" || method === "HEAD";
  if (!isGet && body && typeof body === "object" && !Array.isArray(body)) {
    return { named: body as Record<string, unknown>, positional: null };
  }

  const pathArgs = ctx.rpc.queryArgs.__pathArgs as unknown[] | undefined;
  if (pathArgs && pathArgs.length > 0) {
    return { named: {}, positional: pathArgs };
  }

  return { named: splitRpcParams(ctx.rpc.queryArgs, ctx.fn.args.map((a) => a.name)).args, positional: null };
}

function buildCallExpression(fn: PgbaseFunction, call: CallArgs): ReturnType<typeof sql> {
  const target = sql`${sql.id(fn.schema, fn.name)}`;
  if (call.positional) {
    return sql`${target}(${sql.join(call.positional.map((value) => sql`${value}`))})`;
  }
  const args = fn.args
    .filter((arg) => Object.prototype.hasOwnProperty.call(call.named, arg.name))
    .map((arg) => sql`${sql.id(arg.name)} => ${call.named[arg.name]}`);
  return sql`${target}(${sql.join(args)})`;
}

function assertArgs(fn: PgbaseFunction, call: CallArgs): void {
  if (call.positional) {
    if (call.positional.length < fn.requiredArgCount) {
      throw PgbaseError.functionNotFound(fn.name);
    }
    return;
  }
  for (const arg of fn.args) {
    const provided = Object.prototype.hasOwnProperty.call(call.named, arg.name);
    if (!provided && !arg.hasDefault) throw PgbaseError.functionNotFound(fn.name);
  }
}

export async function executeRpc(ctx: RpcContext, method: string, body: unknown): Promise<RpcResult> {
  const fn = ctx.fn;
  const call = resolveCall(ctx, body, method);
  assertArgs(fn, call);

  const fnCall = buildCallExpression(fn, call);

  // Scalar / record-returning functions: PostgREST returns the bare JSON value.
  if (!fn.returnsSet && !fn.returnsTable) {
    const result = await sql<{ value: unknown }>`select ${fnCall} as value`.execute(ctx.db);
    const rows = [result.rows[0]?.value ?? null];
    assertRpcResult(ctx, rows);
    return { rows, count: null, affected: 1 };
  }

  // Set-returning: treat the function as a derived table so select/filter/
  // order/limit apply as they do for a table.
  const relation = fn.returnRelation ? ctx.schema.tables.get(fn.returnRelation) : undefined;
  const columns = relation ? relation.columns : inferColumns(fn);
  const level = makeLevel(fn, relation, columns);

  let qb: any = ctx.db.selectFrom(fnCall.as(RPC_ALIAS));
  const { filters } = splitRpcParams(ctx.rpc.queryArgs, ctx.fn.args.map((a) => a.name));
  qb = qb.select(buildSelectionList(ctx, level, ctx.rpc.select));
  for (const filter of filters) qb = qb.where(renderFilter(filter, level));
  for (const term of ctx.rpc.order) qb = qb.orderBy(renderOrder(ctx, term));

  // Apply the same row cap as reads so a large SETOF can't bypass `maxRows`.
  let limit = ctx.rpc.limit;
  if (ctx.defaultLimit !== undefined && limit === undefined) limit = ctx.defaultLimit;
  if (ctx.maxRows !== Infinity) {
    limit = limit === undefined ? ctx.maxRows : Math.min(limit, ctx.maxRows);
  }
  if (limit !== undefined) qb = qb.limit(limit);
  if (ctx.rpc.offset !== undefined) qb = qb.offset(ctx.rpc.offset);

  const rows = await qb.execute();
  let count: number | null = null;
  if (ctx.rpc.count) {
    const level0 = makeLevel(fn, relation, columns);
    let countQb: any = ctx.db.selectFrom(fnCall.as(RPC_ALIAS)).select((eb: any) => eb.fn.countAll().as("count"));
    for (const filter of filters) countQb = countQb.where(renderFilter(filter, level0));
    const row = await countQb.executeTakeFirst();
    count = row ? Number((row as any).count) : 0;
  }
  assertRpcResult(ctx, rows);
  return { rows, count, affected: rows.length };
}

/**
 * Singular coercion and `max-affected` are enforced inside the transaction so a
 * violation rolls back any writes the function performed. Bulk invocations are
 * checked once by the caller instead.
 */
function assertRpcResult(ctx: RpcContext, rows: any[]): void {
  if (ctx.rpc.bulkArgs) return;
  if (ctx.rpc.singular && rows.length !== 1) throw PgbaseError.notSingular(rows.length);
  assertMaxAffected(ctx.rpc.prefer, rows.length);
}

/**
 * A lightweight relation-shaped view of a SETOF function's result so the select
 * builder can project columns. `columns` come from the return table when known.
 */
function makeLevel(fn: PgbaseFunction, relation: PgbaseRelation | undefined, columns: PgbaseRelation["columns"]): QueryLevel {
  const base: PgbaseRelation = relation ?? {
    name: fn.name,
    schema: fn.schema,
    kind: "table",
    columns,
    columnMap: new Map(),
    primaryKey: null,
    uniques: [],
  };
  return {
    name: RPC_ALIAS,
    relation: { ...base, columns, columnMap: new Map(columns.map((column) => [column.name, column])) },
    path: "",
  };
}

/** When a SETOF returns an anonymous record, fall back to the declared columns. */
function inferColumns(fn: PgbaseFunction): PgbaseRelation["columns"] {
  const out = fn.args
    .filter((arg) => arg.mode === "o" || arg.mode === "t")
    .map((arg, index) => ({
      name: arg.name,
      type: "text",
      udt: "text",
      nullable: true,
      default: null,
      position: index + 1,
      isArray: false,
    }));
  if (out.length > 0) return out;
  return fn.columns.map((column, index) => ({
    name: column.name,
    type: "text",
    udt: "text",
    nullable: true,
    default: null,
    position: index + 1,
    isArray: false,
  }));
}

function renderOrder(_ctx: RpcContext, term: OrderTerm): ReturnType<typeof sql> {
  const nulls =
    term.nulls === "first" ? sql` nulls first` : term.nulls === "last" ? sql` nulls last` : sql``;
  return sql`${sql.ref(term.column)} ${sql.raw(term.direction)}${nulls}`;
}
