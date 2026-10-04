import type { Kysely } from "kysely";

export type MaybePromise<T> = T | Promise<T>;

/**
 * The minimal `pg`-style client surface pgb needs for a LISTEN connection.
 * Structurally compatible with `pg.Client`, so pgb needn't depend on `pg`.
 */
export interface ListenClient {
  query(sql: string): Promise<unknown>;
  on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  removeListener(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  end(): Promise<void>;
}

/** A column as introspected from the database. */
export interface PgbaseColumn {
  name: string;
  /** `information_schema.columns.data_type`, e.g. `integer`, `ARRAY`, `USER-DEFINED`. */
  type: string;
  /** `information_schema.columns.udt_name`, e.g. `int4`, `_text`, `jsonb`. */
  udt: string;
  nullable: boolean;
  default: string | null;
  position: number;
  isArray: boolean;
}

export interface PgbaseForeignKey {
  constraint: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

export interface PgbaseRelation {
  name: string;
  schema: string;
  kind: "table" | "view" | "materialized_view" | "partitioned_table" | "foreign_table";
  columns: PgbaseColumn[];
  columnMap: Map<string, PgbaseColumn>;
  primaryKey: string[] | null;
  uniques: string[][];
}

export interface PgbaseFunctionArg {
  name: string;
  type: string;
  /** `i` input, `o` output, `b` inout, `t` table, `v` variadic. */
  mode: string;
  hasDefault: boolean;
}

export interface PgbaseFunction {
  schema: string;
  name: string;
  /** `f` function, `p` procedure, `a` aggregate, `w` window. */
  kind: string;
  /** `i` immutable, `s` stable, `v` volatile. */
  volatility: string;
  returnsSet: boolean;
  returnsTable: boolean;
  returnType: string;
  returnRelation: string | null;
  securityDefiner: boolean;
  args: PgbaseFunctionArg[];
  /** Number of leading input args without defaults (positional call minimum). */
  requiredArgCount: number;
  /** Declared output/table columns (for anonymous record returns). */
  columns: Array<{ name: string }>;
}

export interface PgbaseSchema {
  schema: string;
  relations: PgbaseRelation[];
  tables: Map<string, PgbaseRelation>;
  foreignKeys: PgbaseForeignKey[];
  functions: Map<string, PgbaseFunction>;
}

export interface PgbaseExposed {
  tables?: string[];
  views?: string[];
}

export interface PgbaseContext {
  schema: PgbaseSchema;
  schemaName: string;
  url: URL;
  table?: string;
  role?: string | null;
  claims?: Record<string, unknown> | null;
}

/**
 * The claim payload returned by `getSession`. `role` is the Postgres role to
 * impersonate and is the only required field; everything else is arbitrary
 * context exposed to Postgres. Auth-mechanism agnostic: JWTs, sessions, API
 * keys and mTLS all map onto this.
 */
export interface PgbaseSession {
  /** Postgres role to impersonate for this request (`SET LOCAL ROLE`). */
  role: string;
  /**
   * Arbitrary JSON context exposed to Postgres as `request.jwt.claims` (the
   * whole object) and `request.jwt.claim.<key>` per key, matching PostgREST so
   * existing RLS policies keep working.
   */
  [claim: string]: unknown;
}export interface PgbaseConfig<DB = unknown> {
  /** Your Kysely instance. pgb never opens its own connection. */
  database: Kysely<DB>;
  /**
   * Exposed Postgres schema(s). A single string for now; an array is accepted
   * for the upcoming multi-schema support and uses the first entry.
   */
  schemaName?: string | string[];
  /**
   * Extra schemas added to the request `search_path` after the exposed schema,
   * so extensions (PostGIS, etc.) resolve. Defaults to `["public"]`.
   * Mirrors PostgREST's `db-extra-search-path`.
   */
  extraSearchPath?: string[];
  /**
   * Mount point when attached to a larger router, e.g. `/rest`.
   * Defaults to the root (`""`), matching PostgREST.
   */
  basePath?: string;
  /** Hard cap applied to every read. `Infinity` (default) means no cap. */
  maxRows?: number;
  /** Default limit when the request does not specify one. */
  defaultLimit?: number;
  /**
   * Maximum request body size in bytes. Defaults to 1 MiB. Requests over the
   * limit get a 413. Set to `Infinity` to disable (not recommended).
   */
  maxBodyBytes?: number;
  /**
   * Restrict which tables/views are reachable. Omit to expose everything.
   */
  exposed?: PgbaseExposed | false;
  /**
   * Role used when `getSession` returns `null`. Mirrors PostgREST's
   * `db-anon-role`.
   *
   * When both `getSession` and `anonRole` are unset, requests run with the
   * connection's own role. That is convenient for admin-only deployments but
   * risks privilege escalation if the pool connects as an owner, so pgb warns
   * unless {@link PgbaseConfig.allowConnectionRole} opts in explicitly.
   */
  anonRole?: string;
  /**
   * Acknowledge that requests with no resolved role run as the connection's
   * role (i.e. no `SET LOCAL ROLE`). Only needed when neither `getSession` nor
   * `anonRole` is configured; silences the startup warning.
   */
  allowConnectionRole?: boolean;
  /**
   * How much error detail to expose. `"verbose"` (default) includes the
   * Postgres `message`, `details` and `hint`; `"minimal"` returns only `code`
   * and `message`, avoiding leaked row values in constraint details.
   */
  errorVerbosity?: "verbose" | "minimal";
  /**
   * Extra Postgres settings applied transaction-scoped to every request, e.g.
   * `{ statement_timeout: "5s", work_mem: "16MB" }`. Mirrors PostgREST's
   * hoisted transaction settings.
   */
  settings?: Record<string, string | number>;
  /**
   * Reload the schema cache when Postgres emits
   * `NOTIFY pgrst, 'reload schema'`, matching PostgREST. Requires
   * {@link PgbaseConfig.createListenClient} to open a dedicated connection
   * (LISTEN cannot share a pooled client).
   */
  refreshOnNotify?: boolean;
  /**
   * Factory for the dedicated LISTEN connection used by
   * {@link PgbaseConfig.refreshOnNotify}. Return a connected `pg` `Client`.
   */
  createListenClient?: () => MaybePromise<ListenClient>;
  /** Postgres NOTIFY channel. Defaults to `pgrst`. */
  notifyChannel?: string;
  /**
   * Resolve the request's database identity as a claim object. Called at most
   * once per request, inside the request transaction.
   *
   * - `role` is required: pgb runs `SET LOCAL ROLE <role>`. Every other key is
   *   exposed to Postgres as `request.jwt.claims` and `request.jwt.claim.<key>`.
   * - return `null` — no session; fall back to {@link PgbaseConfig.anonRole}.
   * - throw — the error becomes the HTTP response. Throw a `PgbaseError` for a
   *   specific status/code (e.g. 401); any thrown error carrying a numeric
   *   `status`/`statusCode` is honoured as-is.
   *
   * pgb never verifies tokens or reads cookies; that is entirely the host's job.
   */
  getSession?: (request: Request) => MaybePromise<PgbaseSession | null>;
  /** Runs before routing/schema loading. Return a Response to short-circuit. */
  onRequest?: (request: Request) => MaybePromise<Response | void>;
  /** Runs when an error is thrown. Return a Response to override the default. */
  onError?: (error: unknown) => MaybePromise<Response | void>;
  debug?: boolean;
}

export interface Pgbase<DB = unknown> {
  /** Web-standard handler. Attach to Node's http, Bun.serve, Deno.serve, Hono, Elysia, Next, etc. */
  handler(request: Request): Promise<Response>;
  /** Alias of {@link Pgbase.handler}, convenient for `{ fetch: pgb.fetch }`. */
  fetch: (request: Request) => Promise<Response>;
  /** The current introspected schema (loads lazily on first call). */
  schema(): Promise<PgbaseSchema>;
  /** Re-introspect the database schema. */
  refresh(): Promise<PgbaseSchema>;
  /**
   * Start the NOTIFY schema listener, if {@link PgbaseConfig.refreshOnNotify} is
   * enabled. Idempotent. Returns a `stop()` that closes the listener.
   */
  listen(): Promise<{ stop(): Promise<void> }>;
  /** The Kysely instance pgb was configured with. */
  readonly database: Kysely<DB>;
}
