import { type Kysely, sql } from "kysely";
import { PgbaseError } from "./errors.ts";
import { parseMutation, parseRequest, parseRpc } from "./parse/request.ts";
import { executeRead, type BaseContext } from "./query/compile.ts";
import { assertMaxAffected, executeMutation } from "./query/write.ts";
import { executeRpc } from "./query/rpc.ts";
import { buildResponse, buildRpcResponse, buildWriteResponse, errorResponse, VARY } from "./response.ts";
import { introspect } from "./schema/index.ts";
import { applySession } from "./session.ts";
import { startSchemaListener, type NotifyListener } from "./schema-listener.ts";
import { normalizeBasePath, matchBasePath, firstSchema, isWriteMethod } from "./routing.ts";
import type { Pgbase, PgbaseConfig, PgbaseContext, PgbaseRelation, PgbaseSchema, PgbaseSession } from "./types.ts";
import type { WriteMethod, PreferOptions, ParsedRpc } from "./ast.ts";

function rootResponse(schema: PgbaseSchema): Response {
  return Response.json({
    schema: schema.schema,
    tables: schema.relations.map((relation) => relation.name),
  });
}

/** `Allow` header for a relation, mirroring PostgREST's OPTIONS response. */
function relationAllow(relation: PgbaseRelation): string {
  const isView = relation.kind === "view";
  const isMaterialized = relation.kind === "materialized_view";
  const insertable = isMaterialized ? false : isView ? !!relation.insertable : true;
  const updatable = isMaterialized ? false : isView ? !!relation.updatable : true;
  const deletable = isMaterialized ? false : isView ? !!relation.deletable : true;
  const hasPk = (relation.primaryKey?.length ?? 0) > 0;
  const methods = ["OPTIONS", "GET", "HEAD"];
  if (insertable) methods.push("POST");
  if (insertable && updatable && hasPk) methods.push("PUT");
  if (updatable) methods.push("PATCH");
  if (deletable) methods.push("DELETE");
  return methods.join(",");
}

/** Empty 200 response carrying the `Allow` header for OPTIONS requests. */
function infoResponse(allow: string): Response {
  return new Response(null, {
    status: 200,
    headers: { Allow: allow, "Content-Length": "0" },
  });
}

/** Shared dependencies resolved once from the config. */
interface Runtime {
  config: PgbaseConfig<any>;
  schemaName: string;
  searchPath: string[];
  maxRows: number;
  defaultLimit: number | undefined;
  basePath: string;
  maxBodyBytes: number;
  allowUnfilteredViewWrites: boolean;
  settings: Record<string, string | number>;
  verbosity: "verbose" | "minimal";
  transactionEnd: NonNullable<PgbaseConfig<any>["transactionEnd"]>;
  txAllowOverride: boolean;
}

const TRANSACTION_END = new Set([
  "commit",
  "rollback",
  "commit-allow-override",
  "rollback-allow-override",
]);

/** `Prefer: tx=...` is only parsed when the config permits overrides. */
function shouldRollback(
  transactionEnd: Runtime["transactionEnd"],
  prefer: PreferOptions,
): boolean {
  switch (transactionEnd) {
    case "rollback":
      return true;
    case "rollback-allow-override":
      return prefer.transaction !== "commit";
    case "commit-allow-override":
      return prefer.transaction === "rollback";
    default:
      return false;
  }
}

const ROLLBACK_SIGNAL = new Error("pgbase: rollback requested");

/**
 * Run `operation` in a transaction, honoring `Prefer: tx=rollback` (and the
 * configured default). A requested rollback still returns the operation's
 * result, mirroring PostgREST: the response is built as if it committed.
 */
async function runTransaction<T>(
  runtime: Runtime,
  prefer: PreferOptions,
  operation: (trx: any) => Promise<T>,
): Promise<T> {
  if (!shouldRollback(runtime.transactionEnd, prefer)) {
    return runtime.config.database.transaction().execute(operation);
  }
  let value: T | undefined;
  let rolledBack = false;
  try {
    return await runtime.config.database.transaction().execute(async (trx) => {
      const result = await operation(trx);
      // Surface deferred constraint violations before rolling back.
      await sql`set constraints all immediate`.execute(trx);
      value = result;
      rolledBack = true;
      throw ROLLBACK_SIGNAL;
    });
  } catch (error) {
    if (rolledBack) return value as T;
    throw error;
  }
}

/** Resolve the request's identity once, before opening a transaction. */
async function resolveSession(
  runtime: Runtime,
  request: Request,
  ctx: PgbaseContext,
): Promise<PgbaseSession | null> {
  const claims = runtime.config.getSession ? await runtime.config.getSession(request) : null;
  if (claims !== null) {
    if (
      typeof claims !== "object" ||
      Array.isArray(claims) ||
      typeof claims.role !== "string" ||
      claims.role.trim() === ""
    ) {
      throw new PgbaseError("PGRST500", "getSession must return null or claims with a non-empty string role", 500);
    }
    ctx.role = claims.role;
  } else {
    ctx.role = runtime.config.anonRole ?? null;
  }
  ctx.claims = claims;
  return claims;
}

/**
 * Run `operation` inside a transaction. The session has already been resolved
 * (before the transaction, so auth never holds a pooled connection); here we
 * impersonate the role and apply the PostgREST session GUCs. Every entry point
 * (read, write, rpc) goes through here, so the setup can never diverge.
 */
async function withSession<T>(
  runtime: Runtime,
  trx: any,
  request: Request,
  ctx: PgbaseContext,
  path: string,
  session: PgbaseSession | null,
  bodyText: string | undefined,
  timezone: string | null,
  operation: (base: BaseContext) => Promise<T>,
): Promise<T> {
  await applySession(
    trx,
    runtime.searchPath,
    ctx.role ?? null,
    session ?? null,
    request,
    path,
    runtime.settings,
    timezone,
  );
  return operation({
    db: trx,
    schema: ctx.schema,
    bodyText,
    maxRows: runtime.maxRows,
    maxBodyBytes: runtime.maxBodyBytes,
    allowUnfilteredViewWrites: runtime.allowUnfilteredViewWrites,
    defaultLimit: runtime.defaultLimit,
  });
}

/** Reject an oversized request body before it is buffered into memory. */
function assertBodySize(request: Request, limit: number): void {
  const header = request.headers.get("content-length");
  if (header !== null) {
    const length = Number(header);
    if (Number.isFinite(length) && length > limit) throw PgbaseError.bodyTooLarge(limit);
  }
}

/** Read a request body with a hard byte limit, including chunked bodies. */
async function readBodyText(request: Request, limit: number): Promise<string> {
  assertBodySize(request, limit);
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw PgbaseError.bodyTooLarge(limit);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Create a composable, PostgREST-compatible API handler.
 *
 * ```ts
 * const pgb = createPgbase({ database, getSession: () => ({ role: "authenticated" }) });
 * http.createServer((req, res) => void pgb.handler(toWebRequest(req)).then(...));
 * // or any web-standard runtime: Bun.serve, Deno.serve, Hono, Elysia, Next.
 * ```
 */
export function createPgbase<DB = unknown>(config: PgbaseConfig<DB>): Pgbase<DB> {
  if (!config || !config.database) {
    throw new Error("pgbase: `config.database` (a Kysely instance) is required");
  }

  const schemaName = firstSchema(config.schemaName);

  // A request with no resolved role runs as the connection's role, which may be
  // an owner. Require an explicit acknowledgement in that case.
  if (!config.getSession && !config.anonRole && !config.allowConnectionRole) {
    console.warn(
      "[pgbase] no `getSession` or `anonRole` configured: requests run with the " +
        "connection's role. Set `anonRole` or `allowConnectionRole: true` to silence this.",
    );
  }

  const transactionEnd = config.transactionEnd ?? "commit";
  if (!TRANSACTION_END.has(transactionEnd)) {
    throw new Error(
      `pgbase: invalid transactionEnd '${transactionEnd}'. Use "commit", "rollback", "commit-allow-override" or "rollback-allow-override"`,
    );
  }

  const runtime: Runtime = {
    config: config as PgbaseConfig<any>,
    schemaName,
    searchPath: [schemaName, ...(config.extraSearchPath ?? ["public"])],
    maxRows: config.maxRows ?? 1000,
    defaultLimit: config.defaultLimit,
    basePath: normalizeBasePath(config.basePath),
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
    allowUnfilteredViewWrites: config.allowUnfilteredViewWrites ?? false,
    settings: config.settings ?? {},
    verbosity: config.errorVerbosity ?? "verbose",
    transactionEnd,
    txAllowOverride: transactionEnd.endsWith("allow-override"),
  };

  let schemaPromise: Promise<PgbaseSchema> | null = null;
  const loadSchema = (): Promise<PgbaseSchema> => {
    if (!schemaPromise) {
      const pending = introspect(config.database, schemaName, config.exposed);
      schemaPromise = pending;
      // Do not cache a transient rejection forever. Preserve a newer promise
      // installed by refresh()/NOTIFY if this one fails later.
      void pending.catch(() => {
        if (schemaPromise === pending) schemaPromise = null;
      });
    }
    return schemaPromise;
  };

  let listenerPromise: Promise<NotifyListener | null> | null = null;
  const listen = (): Promise<NotifyListener | null> => {
    if (listenerPromise) return listenerPromise;
    const pending = (async () => {
      if (!config.refreshOnNotify) return null;
      if (!config.createListenClient) {
        console.warn("[pgbase] `refreshOnNotify` requires `createListenClient`; listener disabled");
        return null;
      }
      const client = await config.createListenClient();
      return startSchemaListener(client, {
        channel: config.notifyChannel,
        onReload: async () => {
          schemaPromise = null;
          await loadSchema();
        },
        onError: (error) => console.warn("[pgbase] schema listener error", error),
      });
    })();
    listenerPromise = pending;
    void pending.catch(() => {
      if (listenerPromise === pending) listenerPromise = null;
    });
    return pending;
  };

  const handleRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Whether the request resolved to a non-anonymous session. Drives the
    // PostgREST 42501 mapping (403 when authenticated, 401 otherwise).
    let authenticated = false;
    try {
      // The request hook is a cheap gate: it runs before schema introspection.
      const hook = await config.onRequest?.(request);
      if (hook) return hook;

      const rest = matchBasePath(url.pathname, runtime.basePath);
      if (rest === null) return errorResponse(new PgbaseError("PGRST404", "Not Found", 404));

      const schema = await loadSchema();
      const ctx: PgbaseContext = { schema, schemaName, url };

      if (rest === "") {
        return request.method.toUpperCase() === "OPTIONS"
          ? infoResponse("OPTIONS,GET,HEAD")
          : rootResponse(schema);
      }

      const method = request.method.toUpperCase();

      const profileHeader = isWriteMethod(method) ? "content-profile" : "accept-profile";
      const profile = request.headers.get(profileHeader);
      if (profile && profile !== "*" && profile !== schemaName) {
        return errorResponse(PgbaseError.schemaNotExposed(profile, schemaName));
      }

      // Resolve the session once, before any transaction, so auth never holds a
      // pooled connection. Throws (e.g. invalid token) fall through to onError.
      const session = await resolveSession(runtime, request, ctx);
      authenticated = session !== null;

      // RPC: /rpc/<fn>[/<positional args...>]
      if (rest === "rpc" || rest.startsWith("rpc/")) {
        return await handleRpc(runtime, rest.slice(3).replace(/^\/+/, ""), method, request, ctx, session);
      }

      const table = decodeURIComponent(rest);
      if (!schema.tables.has(table)) return errorResponse(PgbaseError.tableNotFound(table));
      ctx.table = table;

      if (method === "OPTIONS") return infoResponse(relationAllow(schema.tables.get(table)!));

      const result = isWriteMethod(method)
        ? await runWrite(runtime, request, ctx, rest, table, method as WriteMethod, session)
        : await runRead(runtime, request, ctx, rest, table, method, session);

      if (config.debug) {
        console.debug(`[pgbase] ${method} ${url.pathname}${url.search} -> ${result.rows} rows`);
      }
      return result.response;
    } catch (error) {
      if (config.debug) console.debug("[pgbase] error", error);
      if (config.onError) {
        try {
          const custom = await config.onError(error);
          if (custom) return custom;
        } catch (hookError) {
          if (config.debug) console.error("[pgbase] onError hook failed", hookError);
        }
      }
      return errorResponse(error, runtime.verbosity, authenticated);
    }
  };

  /**
   * Every response gets PostgREST's default `Vary` header unless it already
   * carries one (or the host returned an immutable response).
   */
  const handler = async (request: Request): Promise<Response> => {
    const response = await handleRequest(request);
    try {
      if (!response.headers.has("Vary")) response.headers.set("Vary", VARY);
    } catch {
      // Immutable host-supplied response: leave it untouched.
    }
    return response;
  };

  return {
    handler,
    fetch: handler,
    schema: loadSchema,
    refresh: () => {
      schemaPromise = null;
      return loadSchema();
    },
    listen: async () => {
      const listener = await listen();
      return { stop: async () => void (await listener?.stop()) };
    },
    database: config.database as Kysely<DB>,
  };
}

// ---------------------------------------------------------------------------
// Operation entry points
// ---------------------------------------------------------------------------

async function runRead(
  runtime: Runtime,
  request: Request,
  ctx: PgbaseContext,
  path: string,
  table: string,
  method: string,
  session: PgbaseSession | null,
): Promise<{ response: Response; rows: number }> {
  if (method !== "GET" && method !== "HEAD") {
    return { response: errorResponse(PgbaseError.methodNotAllowed(request.method)), rows: 0 };
  }

  const parsed = parseRequest(request, runtime.schemaName, table, runtime.txAllowOverride);
  const result = await runTransaction(runtime, parsed.prefer, (trx) =>
    withSession(runtime, trx, request, ctx, path, session, undefined, parsed.prefer.timezone, (exec) =>
      executeRead({ ...exec, request: parsed }),
    ),
  );
  return { response: buildResponse(parsed, result, method, runtime.basePath), rows: result.rows.length };
}

async function runWrite(
  runtime: Runtime,
  request: Request,
  ctx: PgbaseContext,
  path: string,
  table: string,
  method: WriteMethod,
  session: PgbaseSession | null,
): Promise<{ response: Response; rows: number }> {
  const bodyText = await readBodyText(request, runtime.maxBodyBytes);
  const mutation = parseMutation(request, runtime.schemaName, table, method, runtime.txAllowOverride);
  const result = await runTransaction(runtime, mutation.prefer, (trx) =>
    withSession(runtime, trx, request, ctx, path, session, bodyText, mutation.prefer.timezone, (exec) =>
      executeMutation({ ...exec, request: mutation, mutation, bodyText }),
    ),
  );
  return {
    response: buildWriteResponse(mutation, result, ctx, runtime.basePath),
    rows: result.rows.length,
  };
}

/**
 * Argument names the client supplied, used in the PGRST202 message. A JSON
 * POST body provides the keys; GET/HEAD uses the query-string keys (minus
 * control params and positional path segments).
 */
function rpcArgumentKeys(parsed: ParsedRpc, method: string, body: unknown): string[] {
  if (method === "POST" && body !== null && typeof body === "object" && !Array.isArray(body)) {
    return Object.keys(body as Record<string, unknown>);
  }
  return Object.keys(parsed.queryArgs).filter((key) => key !== "__pathArgs");
}

async function handleRpc(
  runtime: Runtime,
  nameArg: string,
  method: string,
  request: Request,
  ctx: PgbaseContext,
  session: PgbaseSession | null,
): Promise<Response> {
  const schema = ctx.schema;
  const parsed = parseRpc(request, runtime.schemaName, nameArg, runtime.txAllowOverride);
  ctx.table = parsed.fn;

  // Parse the body up front: it also supplies the argument keys reported when
  // the function cannot be resolved, and `params=bulk` needs its length.
  let body: unknown = null;
  if (method === "POST") {
    const text = await readBodyText(request, runtime.maxBodyBytes);
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return errorResponse(PgbaseError.parse("Failed to parse the request body as JSON"));
      }
    }
  }

  const fn = schema.functions.get(parsed.fn);
  if (!fn) {
    return errorResponse(
      PgbaseError.functionNotFound(parsed.schema, parsed.fn, {
        argumentKeys: rpcArgumentKeys(parsed, method, body),
        isJsonPost: method === "POST",
      }),
    );
  }
  parsed.readOnly = fn.volatility !== "v";

  if (method === "OPTIONS") {
    return infoResponse(fn.volatility === "v" ? "OPTIONS,POST" : "OPTIONS,GET,HEAD,POST");
  }

  // `max-affected` with handling=strict requires a set-returning function.
  if (
    parsed.prefer.maxAffected !== null &&
    parsed.prefer.handling === "strict" &&
    !fn.returnsSet &&
    !fn.returnsTable
  ) {
    return errorResponse(
      new PgbaseError(
        "PGRST128",
        "Function must return SETOF or TABLE when max-affected preference is used with handling=strict",
        400,
      ),
    );
  }

  if (method === "GET" || method === "HEAD") {
    if (!parsed.readOnly) {
      return errorResponse(
        new PgbaseError("PGRST102", "Only read-only functions can be called with GET", 405, null, null, {
          Allow: "POST",
        }),
      );
    }
  } else if (method !== "POST") {
    return errorResponse(PgbaseError.methodNotAllowed(request.method));
  }

  const path = `rpc/${nameArg}`;
  const invoke = (trx: any, rpcIndex?: number) =>
    withSession(runtime, trx, request, ctx, path, session, undefined, parsed.prefer.timezone, (exec) =>
      executeRpc({ ...exec, request: parsed, rpc: parsed, fn, rpcIndex }, method, body),
    );

  // `Prefer: params=bulk` invokes the function once per array element.
  if (parsed.params === "bulk" && Array.isArray(body)) {
    parsed.bulkArgs = body as Array<Record<string, unknown>>;
    const collected = await runTransaction(runtime, parsed.prefer, (trx) =>
      withSession(runtime, trx, request, ctx, path, session, undefined, parsed.prefer.timezone, async (exec) => {
        const rows: any[] = [];
        for (let i = 0; i < body.length; i++) {
          const result = await executeRpc(
            { ...exec, request: parsed, rpc: parsed, fn, rpcIndex: i },
            method,
            body,
          );
          rows.push(...result.rows);
        }
        // Bulk invocations share one transaction, so `max-affected` applies to
        // the total number of rows they return.
        assertMaxAffected(parsed.prefer, rows.length);
        return rows;
      }),
    );
    return buildRpcResponse(parsed, { rows: collected, count: parsed.count ? collected.length : null }, method);
  }

  const result = await runTransaction(runtime, parsed.prefer, (trx) => invoke(trx));
  return buildRpcResponse(parsed, result, method);
}
