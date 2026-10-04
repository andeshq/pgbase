import type { ParsedMutation, ParsedRpc, ParsedRequest } from "./ast.ts";
import { PgbaseError, fromPostgresError } from "./errors.ts";
import type { ReadResult } from "./query/compile.ts";
import type { MutationResult } from "./query/write.ts";
import type { PgbaseContext } from "./types.ts";

export type ErrorVerbosity = "verbose" | "minimal";

const VARY = "Accept, Prefer, Range, Accept-Profile";

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
): Response {
  const pgbError = error instanceof PgbaseError ? error : fromPostgresError(error, verbosity);
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

export function buildResponse(request: ParsedRequest, result: ReadResult, method: string): Response {
  const { rows, count } = result;
  if (request.singular && rows.length !== 1) throw PgbaseError.notSingular(rows.length);

  const headers = new Headers();
  headers.set("Content-Range", contentRange(request, rows, count));
  if (request.count) headers.set("Preference-Applied", `count=${request.count}`);
  if (request.profile) headers.set("Content-Profile", request.profile);

  return send({
    rows,
    status: request.ranged ? 206 : 200,
    headers,
    format: request.singular ? "singular" : request.format,
    body: method !== "HEAD",
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function appliedPreferences(request: ParsedMutation): string {
  const { return: ret, count, resolution, missing, handling } = request.prefer;
  const parts: string[] = [];
  if (ret) parts.push(`return=${ret}`);
  if (count) parts.push(`count=${count}`);
  if (resolution) parts.push(`resolution=${resolution}`);
  if (missing) parts.push(`missing=${missing}`);
  if (handling) parts.push(`handling=${handling}`);
  return parts.join(", ");
}

function writeStatus(request: ParsedMutation, ctx: PgbaseContext, count: number | null, inserted?: boolean): number {
  if (ctx.role === "anon" && count === 0 && request.method !== "POST") return 401;
  if (request.method === "PUT") return inserted === false ? 200 : 201;
  return request.method === "POST" ? 201 : 200;
}

export function buildWriteResponse(
  request: ParsedMutation,
  result: MutationResult,
  ctx: PgbaseContext,
  basePath = "",
): Response {
  const { rows, count, affected } = result;
  const represent = request.prefer.return === "representation";

  if (request.singular && represent && rows.length !== 1) throw PgbaseError.notSingular(rows.length);

  const headers = new Headers();
  const applied = appliedPreferences(request);
  if (applied) headers.set("Preference-Applied", applied);
  if (count !== null) headers.set("Content-Range", wantsRangeForWrite(request) ? `*/${count}` : "*/*");
  if (request.profile) headers.set("Content-Profile", request.profile);

  // `Location` points at the affected row's primary key, mirroring PostgREST.
  if (request.method === "POST" && result.keys?.length === 1) {
    const query = Object.entries(result.keys[0]!)
      .map(([column, value]) => `${column}=eq.${encodeURIComponent(String(value))}`)
      .join("&");
    if (query) headers.set("Location", `${basePath}/${request.table}?${query}`);
  }

  if (request.prefer.return === "minimal") return new Response(null, { status: 204, headers });

  const status = writeStatus(request, ctx, count, result.inserted);
  const hasBody = request.prefer.return !== "headers-only";
  return send({
    rows,
    status,
    headers,
    format: request.singular ? "singular" : request.format,
    body: hasBody,
  });
}

function wantsRangeForWrite(request: ParsedMutation): boolean {
  return request.method !== "POST" || request.count !== null;
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
  if (request.count) {
    headers.set("Preference-Applied", `count=${request.count}`);
    headers.set("Content-Range", `*/${result.count ?? result.rows.length}`);
  }

  return send({
    rows: result.rows,
    status: 200,
    headers,
    format: request.singular ? "singular" : request.format,
    body: method !== "HEAD",
  });
}
