import type { EmbedParams, FilterNode, OrderTerm, ParsedMutation, ParsedRequest, ParsedRpc, PreferOptions, SelectNode, WriteMethod } from "../ast.ts";import { PgbaseError } from "../errors.ts";
import { parseCondition, parseLogicParam } from "./filter.ts";
import { parseSelect } from "./select.ts";
import { splitTopLevel, unquote } from "./util.ts";

const CONTROL_PARAMS = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);

function parseOrderTerm(raw: string): OrderTerm {
  const parts = splitTopLevel(raw.trim(), ".");
  let direction: "asc" | "desc" = "asc";
  let nulls: "first" | "last" | undefined;

  // PostgREST order syntax is `column.direction.nulls`, so parse from the end.
  const maybeNulls = parts.at(-1);
  if (maybeNulls === "nullsfirst" || maybeNulls === "nullslast") {
    nulls = maybeNulls === "nullsfirst" ? "first" : "last";
    parts.pop();
  }
  const last = parts.at(-1);
  if (last === "asc" || last === "desc") {
    direction = last;
    parts.pop();
  }

  let column = parts.join(".");
  let cast: string | undefined;
  const castIdx = column.lastIndexOf("::");
  if (castIdx !== -1) {
    cast = column.slice(castIdx + 2);
    column = column.slice(0, castIdx);
  }

  let jsonPath: string[] | undefined;
  if (column.includes("->")) {
    const segments = column.split(/->>?/);
    column = unquote(segments[0]!);
    jsonPath = segments.slice(1).map((seg) => unquote(seg));
  } else {
    column = unquote(column);
  }

  if (!column) throw PgbaseError.parse(`failed to parse order term: ${raw}`);
  return { column, direction, nulls, jsonPath, cast };
}

function collectEmbedPaths(nodes: SelectNode[], prefix: string, out: Set<string>): void {
  for (const node of nodes) {
    if (node.kind !== "embed") continue;
    const path = prefix ? `${prefix}.${node.path}` : node.path;
    out.add(path);
    collectEmbedPaths(node.children, path, out);
  }
}

function routeEmbedKey(key: string, paths: Set<string>): { path: string; rest: string } | null {
  const candidates = [...paths].sort((a, b) => b.length - a.length);
  for (const path of candidates) {
    if (key.startsWith(path + ".")) {
      const rest = key.slice(path.length + 1);
      if (rest.length > 0) return { path, rest };
    }
  }
  return null;
}

/**
 * `limit` accepts only non-negative integers; anything else is ignored, except
 * a negative limit which is an unsatisfiable range (PostgREST PGRST103).
 */
function parseLimit(value: string | null, topLevel: boolean): number | undefined {
  if (value == null || value === "") return undefined;
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  if (parsed < 0) {
    if (topLevel) throw PgbaseError.invalidRange("Limit should be greater than or equal to zero.");
    // Embedded ranges have no top-level validity check: a negative limit is an
    // empty range, so nothing is returned.
    return 0;
  }
  return parsed;
}

/** A negative or non-numeric offset is a no-op, mirroring PostgREST. */
function parseOffset(value: string | null): number | undefined {
  if (value == null || value === "") return undefined;
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

interface RangeHeader {
  offset: number;
  end: number | null;
}

/**
 * Parse a `Range` header. Malformed headers are ignored (PostgREST treats them
 * as `allRange`), but a lower bound above the upper bound is PGRST103.
 */
function parseRangeHeader(header: string | null): RangeHeader | null {
  if (!header) return null;
  const match = /^(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (end !== null && end < offset) {
    throw PgbaseError.invalidRange(
      "The lower boundary must be lower than or equal to the upper boundary in the Range header.",
    );
  }
  return { offset, end };
}

function parsePreferCount(header: string | null): ParsedRequest["count"] {
  if (!header) return null;
  for (const token of header.split(",")) {
    const [key, rawValue] = token.split("=").map((s) => s.trim());
    if (key === "count") {
      if (rawValue === "exact" || rawValue === "planned" || rawValue === "estimated") return rawValue;
    }
  }
  return null;
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Writes negotiate the schema with `Content-Profile`, reads with `Accept-Profile`. */
function profileFor(request: Request): string | undefined {
  const header = WRITE_METHODS.has(request.method.toUpperCase()) ? "content-profile" : "accept-profile";
  return request.headers.get(header) ?? undefined;
}

/** PostgREST's canonical location: params sorted by key and re-encoded. */
function canonicalQueryString(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) pairs.push([key, value]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return pairs.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
}

/** Preferences PostgREST recognizes. Anything else is collected as invalid. */
const ACCEPTED_PREFS = new Set([
  "resolution=merge-duplicates",
  "resolution=ignore-duplicates",
  "return=minimal",
  "return=representation",
  "return=headers-only",
  "count=exact",
  "count=planned",
  "count=estimated",
  "tx=commit",
  "tx=rollback",
  "missing=default",
  "missing=null",
  "handling=strict",
  "handling=lenient",
  "params=single-object",
  "params=bulk",
]);

/**
 * Parse every `Prefer` token we understand, e.g. `return=representation`.
 *
 * Mirrors PostgREST: the first occurrence of a preference wins, unknown tokens
 * are recorded, and `handling=strict` turns them into a 400 PGRST122.
 */
export function parsePrefer(header: string | null, allowTxOverride = false): PreferOptions {
  const prefer: PreferOptions = {
    return: null,
    count: parsePreferCount(header),
    resolution: null,
    missing: null,
    handling: null,
    params: "single-object",
    transaction: null,
    timezone: null,
    maxAffected: null,
    invalid: [],
  };
  if (!header) return prefer;

  const seen = new Set<string>();
  for (const raw of header.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (!ACCEPTED_PREFS.has(token) && !token.startsWith("timezone=") && !token.startsWith("max-affected=")) {
      prefer.invalid.push(token);
      continue;
    }
    const key = token.slice(0, token.indexOf("="));
    if (seen.has(key)) continue; // only the first occurrence is used
    seen.add(key);

    if (token === "return=minimal" || token === "return=representation" || token === "return=headers-only") {
      prefer.return = token.slice(7) as PreferOptions["return"];
    } else if (token === "resolution=merge-duplicates" || token === "resolution=ignore-duplicates") {
      prefer.resolution = token.slice(11) as PreferOptions["resolution"];
    } else if (token === "missing=default") {
      prefer.missing = "default";
    } else if (token === "missing=null") {
      prefer.missing = "null";
    } else if (token === "handling=strict" || token === "handling=lenient") {
      prefer.handling = token.slice(9) as PreferOptions["handling"];
    } else if (token === "params=single-object" || token === "params=bulk") {
      prefer.params = token.slice(7) as PreferOptions["params"];
    } else if (allowTxOverride && (token === "tx=commit" || token === "tx=rollback")) {
      prefer.transaction = token.slice(3) as PreferOptions["transaction"];
    } else if (token.startsWith("timezone=")) {
      prefer.timezone = token.slice(9) || null;
    } else if (token.startsWith("max-affected=")) {
      const parsed = Number(token.slice(13));
      prefer.maxAffected = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    }
  }

  if (prefer.handling === "strict" && prefer.invalid.length > 0) {
    throw PgbaseError.invalidPreferences(prefer.invalid);
  }
  return prefer;
}

/**
 * Translate an HTTP request into the read AST. Structural only: column
 * existence is validated later while compiling, once the schema is known.
 */
export function parseRequest(
  request: Request,
  schemaName: string,
  table: string,
  allowTxOverride = false,
): ParsedRequest {
  const url = new URL(request.url);
  const params = url.searchParams;

  const select = parseSelect(params.get("select") ?? "*");
  const embedPaths = new Set<string>();
  collectEmbedPaths(select, "", embedPaths);

  const embeds = new Map<string, EmbedParams>();
  const getEmbed = (path: string): EmbedParams => {
    let entry = embeds.get(path);
    if (!entry) {
      entry = { filters: [], order: [] };
      embeds.set(path, entry);
    }
    return entry;
  };

  const filters: FilterNode[] = [];
  let order: OrderTerm[] = [];

  for (const [key, value] of params.entries()) {
    if (key === "select") continue;

    if (key === "or" || key === "and") {
      filters.push(parseLogicParam(key, false, value));
      continue;
    }
    if (key === "not.or" || key === "not.and") {
      filters.push(parseLogicParam(key.slice(4) as "and" | "or", true, value));
      continue;
    }
    if (key === "order") {
      order = parseOrderTerms(value);
      continue;
    }
    if (key === "limit" || key === "offset" || CONTROL_PARAMS.has(key)) continue;

    const route = routeEmbedKey(key, embedPaths);
    if (route && (route.rest === "limit" || route.rest === "offset" || route.rest === "order")) {
      const embed = getEmbed(route.path);
      if (route.rest === "limit") embed.limit = parseLimit(value, false);
      else if (route.rest === "offset") embed.offset = parseOffset(value);
      else embed.order = parseOrderTerms(value);
      continue;
    }

    if (route) {
      getEmbed(route.path).filters.push(parseCondition(`${route.rest}.${value}`));
    } else {
      filters.push(parseCondition(`${key}.${value}`));
    }
  }

  let start = parseOffset(params.get("offset")) ?? 0;
  let end: number | null = null;
  const limitParam = parseLimit(params.get("limit"), true);
  if (limitParam !== undefined) end = start + limitParam - 1;

  // The Range header is only honored for reads, and intersects with the
  // limit/offset query parameters.
  const method = request.method.toUpperCase();
  const range =
    method === "GET" || method === "HEAD" ? parseRangeHeader(request.headers.get("range")) : null;
  if (range) {
    start = Math.max(start, range.offset);
    if (range.end !== null) end = end === null ? range.end : Math.min(end, range.end);
    if (end !== null && end < start) {
      if (limitParam === 0) {
        // `limit=0` is the one allowed empty range and short-circuits.
        start = 0;
        end = -1;
      } else {
        throw PgbaseError.invalidRange(
          "The lower boundary must be lower than or equal to the upper boundary in the Range header.",
        );
      }
    }
  }
  if (limitParam === 0) {
    start = 0;
    end = -1;
  }

  const limit = end === null ? undefined : end - start + 1;
  const offset = start > 0 ? start : undefined;

  const accept = request.headers.get("accept") ?? "";
  const singular = accept.includes("application/vnd.pgrst.object+json");
  const format: ParsedRequest["format"] = accept.includes("text/csv") ? "csv" : "json";
  const prefer = parsePrefer(request.headers.get("prefer"), allowTxOverride);
  const profile = profileFor(request);

  return {
    table,
    schema: schemaName,
    select,
    filters,
    order,
    limit,
    offset,
    embeds,
    singular,
    count: prefer.count,
    format,
    profile,
    canonicalQuery: canonicalQueryString(url),
    ranged: range !== null,
    prefer,
  };
}

function parseOrderTerms(value: string): OrderTerm[] {
  const terms: OrderTerm[] = [];
  for (const raw of splitTopLevel(value, ",")) {
    if (!raw.trim()) continue;
    terms.push(parseOrderTerm(raw));
  }
  return terms;
}

/**
 * Parse a write request (POST/PATCH/PUT/DELETE). Shares the read parser for
 * `select`, filters and ordering, and adds write-only control params.
 */
export function parseMutation(
  request: Request,
  schemaName: string,
  table: string,
  method: WriteMethod,
  allowTxOverride = false,
): ParsedMutation {
  const base = parseRequest(request, schemaName, table, allowTxOverride);
  const params = new URL(request.url).searchParams;

  let columns: string[] | null = null;
  const columnsParam = params.get("columns");
  if (columnsParam !== null) {
    columns = columnsParam
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
    if (columns.length === 0) throw PgbaseError.parse("failed to parse columns parameter ()");
  }

  let onConflict: string[] | null = null;
  const onConflictParam = params.get("on_conflict");
  if (onConflictParam !== null) {
    onConflict = onConflictParam
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
    if (onConflict.length === 0) throw PgbaseError.parse("failed to parse on_conflict parameter ()");
  }

  // PUT rejects `limit`/`offset`; the check uses the effective range, so a
  // negative (no-op) offset or an ignored non-numeric value is not a range.
  const rangeLimited = base.limit !== undefined || base.offset !== undefined;

  return { ...base, method, columns, onConflict, rangeLimited };
}

/**
 * Split RPC query-string params into function arguments and result filters.
 *
 * A key is a function argument when it matches a declared parameter name;
 * anything else describes the result set (`?published=eq.true`). This needs the
 * function signature, so it runs after introspection rather than in
 * {@link parseRpc}.
 */
export function splitRpcParams(
  queryArgs: Record<string, unknown>,
  argNames: Iterable<string>,
): { args: Record<string, unknown>; filters: FilterNode[] } {
  const known = new Set(argNames);
  const args: Record<string, unknown> = {};
  const filters: FilterNode[] = [];

  for (const [key, value] of Object.entries(queryArgs)) {
    if (key === "__pathArgs" || known.has(key)) {
      if (key !== "__pathArgs") args[key] = value;
      continue;
    }
    if (key === "or" || key === "and") {
      filters.push(parseLogicParam(key, false, String(value)));
      continue;
    }
    if (key === "not.or" || key === "not.and") {
      filters.push(parseLogicParam(key.slice(4) as "and" | "or", true, String(value)));
      continue;
    }
    filters.push(parseCondition(`${key}.${value}`));
  }

  return { args, filters };
}

/**
 * Parse an RPC request. Arguments are resolved per call, not here, because
 * a function's parameter names/types are only known from the schema.
 *
 * `nameArg` is the decoded path segment after `rpc/`; extra segments select an
 * overload, e.g. `/rpc/add/2/1`.
 */
export function parseRpc(
  request: Request,
  schemaName: string,
  nameArg: string,
  allowTxOverride = false,
): ParsedRpc {
  const segments = nameArg.split("/").map((segment) => decodeURIComponent(segment));
  const fn = segments[0] ?? "";
  const pathArgs = segments.slice(1);

  const url = new URL(request.url);
  const params = url.searchParams;
  const select = parseSelect(params.get("select") ?? "*");
  const prefer = parsePrefer(request.headers.get("prefer"), allowTxOverride);
  const order = params.get("order") ? parseOrderTerms(params.get("order")!) : [];
  const limit = parseLimit(params.get("limit"), true);
  const offset = parseOffset(params.get("offset"));

  const queryArgs: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "offset") continue;
    queryArgs[key] = value;
  }
  if (pathArgs.length > 0) queryArgs.__pathArgs = pathArgs;

  const accept = request.headers.get("accept") ?? "";
  const singular = accept.includes("application/vnd.pgrst.object+json");
  const format: ParsedRequest["format"] = accept.includes("text/csv") ? "csv" : "json";

  return {
    table: fn,
    fn,
    schema: schemaName,
    select,
    filters: [],
    order,
    limit,
    offset,
    embeds: new Map(),
    singular,
    count: prefer.count,
    format,
    profile: profileFor(request),
    canonicalQuery: canonicalQueryString(url),
    ranged: false,
    prefer,
    params: prefer.params,
    bulkArgs: null,
    queryArgs,
    readOnly: false,
  };
}
