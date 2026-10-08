import type { ParsedMutation, ParsedRpc, ParsedRequest } from "./ast.ts";
import { PgbaseError, fromPostgresError } from "./errors.ts";
import type { ReadResult } from "./query/compile.ts";
import type { MutationResult } from "./query/write.ts";
import type { PgbaseContext } from "./types.ts";

export type ErrorVerbosity = "verbose" | "minimal";

export const VARY = "Accept, Prefer, Range";

type BodyFormat = "json" | "csv" | "singular";

interface SendOptions {
  rows: any[];
  status: number;
  headers: Headers;
  format: BodyFormat;
  /** When false, no body is written (HEAD, minimal/headers-only preferences). */
  body: boolean;
}

/** Serialize rows and build the response body for the requested format. */
function serialize(rows: any[], format: BodyFormat): string {
  if (format === "singular") return JSON.stringify(rows[0] ?? null);
  if (format === "csv") return toCsv(rows);
  return JSON.stringify(rows);
}

function contentType(format: BodyFormat): string {
  if (format === "csv") return "text/csv; charset=utf-8";
  if (format === "singular") return "application/vnd.pgrst.object+json; charset=utf-8";
  return "application/json; charset=utf-8";
}

function send({ rows, status, headers, format, body }: SendOptions): Response {
  headers.set("Vary", VARY);
  headers.set("Content-Type", contentType(format));
  return new Response(body ? serialize(rows, format) : null, { status, headers });
}

function toCsv(rows: any[]): string {
  if (rows.length === 0) return "";
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  }
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [keys.join(",")];
  for (const row of rows) lines.push(keys.map((key) => escape(row[key])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function errorResponse(
  error: unknown,
  verbosity: "verbose" | "minimal" = "verbose",
  authenticated = false,
): Response {
  const pgbError =
    error instanceof PgbaseError ? error : fromPostgresError(error, verbosity, authenticated);
  const headers = new Headers(pgbError.headers ?? {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(pgbError.toJSON()), {
    status: pgbError.status,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function contentRange(request: ParsedRequest, rows: any[], count: number | null): string {
  const total = count ?? "*";
  if (rows.length === 0) return `*/${total}`;
  const start = request.offset ?? 0;
  return `${start}-${start + rows.length - 1}/${total}`;
}

/**
 * PostgREST's read status: `200` unless a count was requested, in which case a
 * partial window is `206` and an offset past the last row is `416`.
 */
function readStatus(request: ParsedRequest, rows: any[], count: number | null): number {
  if (count === null) return 200;
  const start = request.offset ?? 0;
  if (start > count) return 416;
  return rows.length < count ? 206 : 200;
}

/** `Preference-Applied` for reads/RPC: only explicitly requested preferences. */
function readAppliedPreferences(request: ParsedRequest, includeMaxAffected = false): string {
  const parts: string[] = [];
  if (request.count) parts.push(`count=${request.count}`);
  if (request.prefer.handling) parts.push(`handling=${request.prefer.handling}`);
  if (includeMaxAffected && request.prefer.handling === "strict" && request.prefer.maxAffected !== null) {
    parts.push(`max-affected=${request.prefer.maxAffected}`);
  }
  return parts.join(", ");
}

export function buildResponse(
  request: ParsedRequest,
  result: ReadResult,
  method: string,
  basePath = "",
): Response {
  const { rows, count } = result;

  const headers = new Headers();
  headers.set("Content-Range", contentRange(request, rows, count));
  headers.set(
    "Content-Location",
    `${basePath}/${request.table}${request.canonicalQuery ? `?${request.canonicalQuery}` : ""}`,
  );
  const applied = readAppliedPreferences(request);
  if (applied) headers.set("Preference-Applied", applied);
  if (request.profile) headers.set("Content-Profile", request.profile);

  if (request.singular && rows.length !== 1) throw PgbaseError.notSingular(rows.length);

  const status = readStatus(request, rows, count);
  if (status === 416) {
    const error = PgbaseError.rangeOutOfBounds(request.offset ?? 0, count ?? 0);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(error.toJSON()), { status, headers });
  }

  return send({
    rows,
    status,
    headers,
    format: request.singular ? "singular" : request.format,
    body: method !== "HEAD",
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Build `Preference-Applied` for writes, mirroring PostgREST: only preferences
 * explicitly requested are echoed, in a fixed order, and some are scoped to the
 * method (resolution only for POST with a conflict target, missing only for
 * POST/PATCH, max-affected only for PATCH/DELETE under handling=strict).
 */
function appliedPreferences(request: ParsedMutation, result: MutationResult): string {
  const { return: ret, count, resolution, missing, handling, maxAffected } = request.prefer;
  const parts: string[] = [];
  if (request.method === "POST" && resolution && result.resolutionApplied) {
    parts.push(`resolution=${resolution}`);
  }
  if ((request.method === "POST" || request.method === "PATCH") && missing) {
    parts.push(`missing=${missing}`);
  }
  if (ret) parts.push(`return=${ret}`);
  if (count) parts.push(`count=${count}`);
  if (handling) parts.push(`handling=${handling}`);
  if (
    handling === "strict" &&
    maxAffected !== null &&
    (request.method === "PATCH" || request.method === "DELETE")
  ) {
    parts.push(`max-affected=${maxAffected}`);
  }
  return parts.join(", ");
}

/**
 * PostgREST write status codes: creates are always `201` (or `200` when
 * `merge-duplicates` inserted nothing), and updates/deletes are `200` only when
 * a representation is requested; every other write preference is `204`.
 */
function writeStatus(
  request: ParsedMutation,
  ctx: PgbaseContext,
  count: number | null,
  inserted?: boolean,
): number {
  // An anonymous representation request that matched zero rows is surfaced as
  // 401 rather than 200 with an empty body.
  if (
    ctx.role === "anon" &&
    count === 0 &&
    request.method !== "POST" &&
    request.prefer.return === "representation"
  ) {
    return 401;
  }
  if (request.method === "POST") {
    if (request.prefer.resolution === "merge-duplicates" && (count ?? 0) === 0) return 200;
    return 201;
  }
  if (request.prefer.return === "representation") {
    if (request.method === "PUT") return inserted === false ? 200 : 201;
    return 200;
  }
  return 204;
}

/**
 * `Content-Range` for writes, mirroring PostgREST: POST and DELETE report `*`,
 * PATCH reports the affected window, and PUT reports no range at all. The total
 * is the affected count only when `Prefer: count` was requested.
 */
function writeContentRange(request: ParsedMutation, count: number | null): string | null {
  if (request.method === "PUT") return null;
  const total = request.count ? String(count ?? 0) : "*";
  if (request.method === "PATCH" && (count ?? 0) > 0) return `0-${count! - 1}/${total}`;
  return `*/${total}`;
}

export function buildWriteResponse(
  request: ParsedMutation,
  result: MutationResult,
  ctx: PgbaseContext,
  basePath = "",
): Response {
  const { rows, count } = result;

  const headers = new Headers();
  const applied = appliedPreferences(request, result);
  if (applied) headers.set("Preference-Applied", applied);
  const range = writeContentRange(request, count);
  if (range !== null) headers.set("Content-Range", range);
  if (request.profile) headers.set("Content-Profile", request.profile);

  // PostgREST only builds a `Location` for POST + `return=headers-only`, and
  // only when exactly one row was created.
  if (request.method === "POST" && request.prefer.return === "headers-only" && result.keys?.length === 1) {
    const query = Object.entries(result.keys[0]!)
      .map(([column, value]) => `${column}=eq.${encodeURIComponent(String(value))}`)
      .join("&");
    if (query) headers.set("Location", `${basePath}/${request.table}?${query}`);
  }

  const status = writeStatus(request, ctx, count, result.inserted);
  if (request.prefer.return !== "representation") return new Response(null, { status, headers });

  return send({
    rows,
    status,
    headers,
    format: request.singular ? "singular" : request.format,
    body: true,
  });
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export function buildRpcResponse(
  request: ParsedRpc,
  result: { rows: any[]; count: number | null },
  method: string,
): Response {
  const headers = new Headers();
  if (request.profile) headers.set("Content-Profile", request.profile);
  headers.set("Content-Range", contentRange(request, result.rows, result.count));
  const applied = readAppliedPreferences(request, true);
  if (applied) headers.set("Preference-Applied", applied);

  const status = readStatus(request, result.rows, result.count);
  if (status === 416) {
    const error = PgbaseError.rangeOutOfBounds(request.offset ?? 0, result.count ?? 0);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(error.toJSON()), { status, headers });
  }

  return send({
    rows: result.rows,
    status,
    headers,
    format: request.singular ? "singular" : request.format,
    body: method !== "HEAD",
  });
}
