import { type Kysely } from "kysely";
import { PgbaseError } from "./errors.ts";
import { parseMutation, parseRequest, parseRpc } from "./parse/request.ts";
import { executeRead, type BaseContext } from "./query/compile.ts";
import { executeMutation } from "./query/write.ts";
import { executeRpc } from "./query/rpc.ts";
import { buildResponse, buildRpcResponse, buildWriteResponse, errorResponse } from "./response.ts";
import { introspect } from "./schema/index.ts";
import { applySession } from "./session.ts";
import { startSchemaListener, type NotifyListener } from "./schema-listener.ts";
import { normalizeBasePath, matchBasePath, firstSchema, isWriteMethod } from "./routing.ts";
import type { Pgbase, PgbaseConfig, PgbaseContext, PgbaseSchema, PgbaseSession } from "./types.ts";
import type { WriteMethod } from "./ast.ts";

function rootResponse(schema: PgbaseSchema): Response {
  return Response.json({
    schema: schema.schema,
    tables: schema.relations.map((relation) => relation.name),
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
  settings: Record<string, string | number>;
  verbosity: "verbose" | "minimal";
}

/** Resolve the request's identity once, before opening a transaction. */
async function resolveSession(
  runtime: Runtime,
  request: Request,
  ctx: PgbaseContext,
): Promise<PgbaseSession | null> {
  const claims = runtime.config.getSession ? await runtime.config.getSession(request) : null;
  ctx.role = claims?.role ?? (claims === null ? (runtime.config.anonRole ?? null) : null);
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
  );
  return operation({
    db: trx,
    schema: ctx.schema,
    raw: request,
    maxRows: runtime.maxRows,
    maxBodyBytes: runtime.maxBodyBytes,
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

/** Read the request body as text, enforcing the size limit on the actual bytes. */
async function readBodyText(request: Request, limit: number): Promise<string> {
  assertBodySize(request, limit);
  const text = await request.clone().text();
  if (text.length > limit) throw PgbaseError.bodyTooLarge(limit);
  return text;
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

  const runtime: Runtime = {
    config: config as PgbaseConfig<any>,
    schemaName,
    searchPath: [schemaName, ...(config.extraSearchPath ?? ["public"])],
    maxRows: config.maxRows ?? Infinity,
    defaultLimit: config.defaultLimit,
    basePath: normalizeBasePath(config.basePath),
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
    settings: config.settings ?? {},
    verbosity: config.errorVerbosity ?? "verbose",
  };

  let schemaPromise: Promise<PgbaseSchema> | null = null;
  const loadSchema = (): Promise<PgbaseSchema> => {
    if (!schemaPromise) {
      schemaPromise = introspect(config.database, schemaName, config.exposed);
    }
    return schemaPromise;
  };

  let listenerPromise: Promise<NotifyListener | null> | null = null;
  const listen = (): Promise<NotifyListener | null> => {
    if (listenerPromise) return listenerPromise;
    listenerPromise = (async () => {
      if (!config.refreshOnNotify) return null;
      if (!config.createListenClient) {
        console.warn("[pgbase] `refreshOnNotify` requires `createListenClient`; listener disabled");
        return null;
      }
      const client = await config.createListenClient();
      return startSchemaListener(client, {
        channel: config.notifyChannel,
        onReload: () => {
          schemaPromise = null;
          void loadSchema();
        },
        onError: (error) => console.warn("[pgbase] schema listener error", error),
      });
    })();
    return listenerPromise;
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      // The request hook is a cheap gate: it runs before schema introspection.
      const hook = await config.onRequest?.(request);
      if (hook) return hook;

      const rest = matchBasePath(url.pathname, runtime.basePath);
      if (rest === null) return errorResponse(new PgbaseError("PGRST404", "Not Found", 404));

      const schema = await loadSchema();
      const ctx: PgbaseContext = { schema, schemaName, url };

      if (rest === "") return rootResponse(schema);

      const profile = request.headers.get("accept-profile");
      if (profile && profile !== "*" && profile !== schemaName) {
        return errorResponse(PgbaseError.schemaNotExposed(profile, schemaName));
      }

      const method = request.method.toUpperCase();

      // Resolve the session once, before any transaction, so auth never holds a
      // pooled connection. Throws (e.g. invalid token) fall through to onError.
      const session = await resolveSession(runtime, request, ctx);

      // RPC: /rpc/<fn>[/<positional args...>]
      if (rest === "rpc" || rest.startsWith("rpc/")) {
        return await handleRpc(runtime, rest.slice(3).replace(/^\/+/, ""), method, request, ctx, session);
      }

      const table = decodeURIComponent(rest);
      if (!schema.tables.has(table)) return errorResponse(PgbaseError.tableNotFound(table));
      ctx.table = table;

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
        const custom = await config.onError(error);
        if (custom) return custom;
      }
      return errorResponse(error, runtime.verbosity);
    }
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

  const parsed = parseRequest(request, runtime.schemaName, table);
  const result = await runtime.config.database.transaction().execute((trx) =>
    withSession(runtime, trx, request, ctx, path, session, (exec) =>
      executeRead({ ...exec, request: parsed }),
    ),
  );
  return { response: buildResponse(parsed, result, method), rows: result.rows.length };
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
  assertBodySize(request, runtime.maxBodyBytes);
  const mutation = parseMutation(request, runtime.schemaName, table, method);
  const result = await runtime.config.database.transaction().execute((trx) =>
    withSession(runtime, trx, request, ctx, path, session, (exec) =>
      executeMutation({ ...exec, request: mutation, mutation }),
    ),
  );
  return {
    response: buildWriteResponse(mutation, result, ctx, runtime.basePath),
    rows: result.rows.length,
  };
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
  const parsed = parseRpc(request, runtime.schemaName, nameArg);
  ctx.table = parsed.fn;

  const fn = schema.functions.get(parsed.fn);
  if (!fn) return errorResponse(PgbaseError.functionNotFound(parsed.fn));
  parsed.readOnly = fn.volatility !== "v";

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

  // Parse the body up front so `params=bulk` knows how many invocations to run.
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

  const path = `rpc/${nameArg}`;
  const invoke = (trx: any, rpcIndex?: number) =>
    withSession(runtime, trx, request, ctx, path, session, (exec) =>
      executeRpc({ ...exec, request: parsed, rpc: parsed, fn, rpcIndex }, method, body),
    );

  // `Prefer: params=bulk` invokes the function once per array element.
  if (parsed.params === "bulk" && Array.isArray(body)) {
    parsed.bulkArgs = body as Array<Record<string, unknown>>;
    const collected: any[] = [];
    for (let i = 0; i < body.length; i++) {
      const result = await runtime.config.database.transaction().execute((trx) => invoke(trx, i));
      collected.push(...result.rows);
    }
    return buildRpcResponse(parsed, { rows: collected, count: collected.length }, method);
  }

  const result = await runtime.config.database.transaction().execute((trx) => invoke(trx));
  return buildRpcResponse(parsed, result, method);
}

