/**
 * Errors are serialized the same way PostgREST serializes them:
 *
 * ```json
 * { "code": "PGRST100", "details": "...", "hint": "...", "message": "..." }
 * ```
 */
export class PgbaseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: string | null;
  readonly hint: string | null;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: string,
    message: string,
    status: number,
    details: string | null = null,
    hint: string | null = null,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "PgbaseError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.hint = hint;
    this.headers = headers;
  }

  toJSON() {
    return {
      code: this.code,
      details: this.details,
      hint: this.hint,
      message: this.message,
    };
  }

  static parse(message: string, details: string | null = null) {
    return new PgbaseError("PGRST100", message, 400, details);
  }

  /** Invalid JSON body or a bulk array with mismatched keys. */
  static invalidBody(message = "All object keys must match") {
    return new PgbaseError("PGRST102", message, 400);
  }

  static invalidRange(details: string) {
    return new PgbaseError("PGRST103", "Requested range not satisfiable", 416, details);
  }

  /** A requested offset lies past the last row, so no range can be served. */
  static rangeOutOfBounds(offset: number, total: number) {
    return new PgbaseError(
      "PGRST103",
      "Requested range not satisfiable",
      416,
      `An offset of ${offset} was requested, but there are only ${total} rows.`,
    );
  }

  /** PUT requires the query filters to be exactly the primary-key `eq` columns. */
  static invalidFilters() {
    return new PgbaseError(
      "PGRST105",
      "Filters must include all and only primary key columns with 'eq' operators",
      405,
    );
  }

  static putLimitNotAllowed() {
    return new PgbaseError(
      "PGRST114",
      "limit/offset querystring parameters are not allowed for PUT",
      400,
    );
  }

  static putMatchingPk() {
    return new PgbaseError(
      "PGRST115",
      "Payload values do not match URL in primary key column(s)",
      400,
    );
  }

  static invalidPreferences(invalid: string[]) {
    return new PgbaseError(
      "PGRST122",
      "Invalid preferences given with handling=strict",
      400,
      `Invalid preferences: ${invalid.join(", ")}`,
    );
  }

  static maxAffected(count: number) {
    return new PgbaseError(
      "PGRST124",
      "Query result exceeds max-affected preference constraint",
      400,
      `The query affects ${count} rows`,
    );
  }

  static schemaNotExposed(schema: string, allowed: string) {
    return new PgbaseError(
      "PGRST106",
      `The schema must be one of the following: ${allowed}`,
      406,
      `The schema '${schema}' is not exposed`,
    );
  }

  static columnNotFound(column: string, table: string) {
    return new PgbaseError(
      "PGRST204",
      `Could not find the '${column}' column of '${table}' in the schema cache`,
      400,
    );
  }

  static tableNotFound(table: string) {
    return new PgbaseError(
      "PGRST205",
      `Could not find the table '${table}' in the schema cache`,
      404,
    );
  }

  static relationshipNotFound(from: string, to: string) {
    return new PgbaseError(
      "PGRST200",
      `Could not find a relationship between '${from}' and '${to}' in the schema cache`,
      400,
    );
  }

  static ambiguousEmbedding(from: string, to: string, hints: string[]) {
    return new PgbaseError(
      "PGRST201",
      `Could not embed because more than one relationship was found for '${from}' and '${to}'`,
      300,
      null,
      `Try changing '${to}' to one of the following: ${hints.map((h) => `'${h}'`).join(", ")}`,
    );
  }

  static notSingular(count: number) {
    return new PgbaseError(
      "PGRST116",
      "Cannot coerce the result to a single JSON object",
      406,
      `The result contains ${count} rows`,
    );
  }

  static methodNotAllowed(method: string) {
    return new PgbaseError("PGRST405", `Method not allowed: ${method}`, 405, null, null, {
      Allow: "GET, HEAD, POST, PATCH, PUT, DELETE",
    });
  }

  static relationNotWritable(relation: string, method: string) {
    return new PgbaseError(
      "PGRST405",
      `Cannot ${method} relation '${relation}' because it is not writable`,
      405,
      null,
      null,
      { Allow: "GET, HEAD" },
    );
  }

  static relationshipEmpty(message = "Cannot embed a relationship: no rows to relate to") {
    return new PgbaseError("PGRST124", message, 400);
  }

  static functionNotFound(fn: string, hint?: string) {
    return new PgbaseError(
      "PGRST202",
      `Could not find the function public.${fn} with the specified parameters in the schema cache`,
      404,
      null,
      hint ?? null,
    );
  }

  static notImplemented(message: string) {
    return new PgbaseError("PGRST117", message, 501);
  }

  /** POST/PATCH/PUT body exceeded `maxBodyBytes`. */
  static bodyTooLarge(limit: number) {
    return new PgbaseError(
      "PGRST113",
      `Request body exceeds the maximum allowed size of ${limit} bytes`,
      413,
    );
  }
}

/**
 * Sentinel meaning "let Postgres apply the column default". Used as the RHS of
 * `set`/`values` so `Prefer: missing=default` maps an omitted column to
 * `default` instead of `null`.
 */
export const DEFAULT = Symbol.for("pgbase.DEFAULT");

/** Postgres SQLSTATE -> HTTP status. */
const PG_STATUS: Record<string, number> = {
  "23505": 409, // unique_violation
  "23503": 409, // foreign_key_violation
  "23514": 400, // check_violation
  "23502": 400, // not_null_violation
  "22007": 400, // invalid_datetime_format
  "22008": 400, // datetime_field_overflow
  "22023": 400, // invalid_parameter_value
  "22P02": 400, // invalid_text_representation
  "22003": 400, // numeric_value_out_of_range
  "42703": 400, // undefined_column
  "42P01": 404, // undefined_table
  "42501": 401, // insufficient_privilege (role-aware in fromPostgresError: 403 if authenticated)
  "42883": 404, // undefined_function
  "42P17": 500, // invalid_object_definition
  "40001": 500, // serialization_failure
  "40P01": 500, // deadlock_detected
  "57014": 500, // query_canceled
  P0001: 400, // raise_exception
};

function statusForPgCode(code: string): number {
  const direct = PG_STATUS[code];
  if (direct !== undefined) return direct;
  // Classes PostgREST maps to 403 (see its "Errors from PostgreSQL" table).
  if (code.startsWith("0L")) return 403; // invalid_grantor
  if (code.startsWith("0P")) return 403; // invalid_role_specification
  if (code.startsWith("28")) return 403; // invalid_authorization_specification
  if (code.startsWith("22")) return 400;
  if (code.startsWith("23")) return 409;
  if (code.startsWith("42")) return 400;
  if (code.startsWith("53")) return 503;
  if (code.startsWith("PT")) return 400;
  return 500;
}

/** SQLSTATEs are 5 chars, uppercase letters and digits (e.g. `42501`, `22P02`, `P0001`). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Extract the Postgres SQLSTATE from a driver error, wherever it lives.
 *
 * Drivers disagree: node-postgres and postgres.js put it in `code`, while Bun SQL
 * sets `code` to a generic `ERR_POSTGRES_SERVER_ERROR` and puts the SQLSTATE in
 * `errno`. Accept any of `code`/`errno`/`sqlState` that looks like a SQLSTATE,
 * so a denied write maps to 401/403 instead of falling through to a 500.
 */
function sqlStateOf(error: { code?: unknown; errno?: unknown; sqlState?: unknown }): string | undefined {
  for (const candidate of [error.code, error.errno, error.sqlState]) {
    if (typeof candidate === "string" && SQLSTATE.test(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Convert any thrown value into a PostgREST-shaped error. `verbosity` controls
 * whether `details`/`hint` are preserved ("verbose") or dropped ("minimal").
 */
export function fromPostgresError(
  error: unknown,
  verbosity: "verbose" | "minimal" = "verbose",
  authenticated = false,
): PgbaseError {
  if (error instanceof PgbaseError) return error;

  // A thrown error carrying a numeric HTTP status (e.g. a framework's
  // `HTTPException`) is honoured as-is, so hosts can throw their own 401s.
  const status = numericStatus(error);
  if (status !== undefined) {
    const message =
      error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown })?.message === "string"
          ? ((error as { message: string }).message)
          : "Error";
    const code = pgbCodeForStatus(status);
    return new PgbaseError(code, message, status);
  }

  const err = error as {
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
    message?: unknown;
    detail?: unknown;
    hint?: unknown;
  };
  const message = typeof err?.message === "string" ? err.message : "Internal Server Error";
  const exposeDetail = verbosity === "verbose";
  const details = exposeDetail && typeof err?.detail === "string" ? err.detail : null;
  const hint = exposeDetail && typeof err?.hint === "string" ? err.hint : null;

  const sqlState = sqlStateOf(err);

  // No SQLSTATE: some drivers/edge runtimes wrap the server error and drop it.
  // If it still reads like a privilege denial, map it rather than returning 500.
  if (!sqlState) {
    if (/permission denied|insufficient privilege/i.test(message)) {
      const denied = authenticated ? 403 : 401;
      return new PgbaseError(pgbCodeForStatus(denied), message, denied, details, hint);
    }
    return new PgbaseError("PGRST500", message, 500, details, hint);
  }

  // 42501 (insufficient_privilege) covers both "permission denied" and RLS
  // `with check` violations. PostgREST maps it to 403 when authenticated, else
  // 401, so an authenticated caller denied on a write gets 403 rather than 401.
  if (sqlState === "42501") {
    return new PgbaseError(sqlState, message, authenticated ? 403 : 401, details, hint);
  }

  // Only normalize the known non-updatable-view errors. SQLSTATE 55000 is
  // broader and must not be mapped wholesale to a client error.
  if (
    sqlState === "55000" &&
    /views that do not select from a single table or view are not automatically updatable|cannot change materialized view/i.test(message)
  ) {
    return new PgbaseError("PGRST405", message, 405, details, hint, { Allow: "GET, HEAD" });
  }

  return new PgbaseError(sqlState, message, statusForPgCode(sqlState), details, hint);
}

/** Read a numeric HTTP status from a thrown error, if it carries one. */
function numericStatus(error: unknown): number | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const candidate =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
    return candidate;
  }
  return undefined;
}

/** Map a bare HTTP status to a PostgREST-style code. */
function pgbCodeForStatus(status: number): string {
  if (status === 401) return "PGRST301";
  if (status === 403) return "PGRST302";
  if (status === 404) return "PGRST404";
  if (status === 405) return "PGRST405";
  if (status >= 500) return "PGRST500";
  return "PGRST000";
}
