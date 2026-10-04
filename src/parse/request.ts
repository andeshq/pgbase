import type { EmbedParams, FilterNode, OrderTerm, ParsedMutation, ParsedRequest, ParsedRpc, PreferOptions, SelectNode, WriteMethod } from "../ast.ts";import { PgbError } from "../errors.ts";
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

  if (!column) throw PgbError.parse(`failed to parse order term: ${raw}`);
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

function parseSize(value: string, name: string): number {
  if (!/^\d+$/.test(value.trim())) throw PgbError.parse(`invalid ${name}: ${value}`);
  return Number(value);
}

function parseOptionalSize(value: string | null, name: string): number | undefined {
  if (value == null || value === "") return undefined;
  return parseSize(value, name);
}

interface RangeHeader {
  offset: number;
  limit: number | null;
}

function parseRangeHeader(header: string | null): RangeHeader | null {
  if (!header) return null;
  const match = /^(\d+)-(\d*)$/.exec(header.trim());
  if (!match) throw PgbError.invalidRange(`invalid range: ${header}`);
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (end !== null && end < offset) throw PgbError.invalidRange(`invalid range: ${header}`);
  return { offset, limit: end !== null ? end - offset + 1 : null };
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

/** Parse every `Prefer` token we understand, e.g. `return=representation`. */
export function parsePrefer(header: string | null): PreferOptions {
  const prefer: PreferOptions = {
    return: "minimal",
    count: parsePreferCount(header),
    resolution: null,
    missing: null,
    handling: null,
    params: "single-object",
  };
  if (!header) return prefer;
  for (const token of header.split(",")) {
    const [key, rawValue] = token.split("=").map((s) => s.trim());
    if (key === "return" && (rawValue === "minimal" || rawValue === "representation" || rawValue === "headers-only")) {
      prefer.return = rawValue;
    } else if (key === "resolution" && (rawValue === "merge-duplicates" || rawValue === "ignore-duplicates")) {
      prefer.resolution = rawValue;
    } else if (key === "missing" && rawValue === "default") {
      prefer.missing = "default";
    } else if (key === "handling" && (rawValue === "strict" || rawValue === "lenient")) {
      prefer.handling = rawValue;
    } else if (key === "params" && (rawValue === "single-object" || rawValue === "bulk")) {
      prefer.params = rawValue;
    }
  }
  return prefer;
}

/**
 * Translate an HTTP request into the read AST. Structural only: column
 * existence is validated later while compiling, once the schema is known.
 */
export function parseRequest(request: Request, schemaName: string, table: string): ParsedRequest {
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
      if (route.rest === "limit") embed.limit = parseSize(value, key);
      else if (route.rest === "offset") embed.offset = parseSize(value, key);
      else embed.order = parseOrderTerms(value);
      continue;
    }

    if (route) {
      getEmbed(route.path).filters.push(parseCondition(`${route.rest}.${value}`));
    } else {
      filters.push(parseCondition(`${key}.${value}`));
    }
  }

  let limit = parseOptionalSize(params.get("limit"), "limit");
  let offset = parseOptionalSize(params.get("offset"), "offset");

  const ranged = request.headers.has("range");
  const range = parseRangeHeader(request.headers.get("range"));
  if (range) {
    if (offset === undefined) offset = range.offset;
    if (limit === undefined && range.limit !== null) limit = range.limit;
  }

  const accept = request.headers.get("accept") ?? "";
  const singular = accept.includes("application/vnd.pgrst.object+json");
  const format: ParsedRequest["format"] = accept.includes("text/csv") ? "csv" : "json";
  const prefer = parsePrefer(request.headers.get("prefer"));
  const profile = request.headers.get("accept-profile") ?? undefined;

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
    ranged,
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
): ParsedMutation {
  const base = parseRequest(request, schemaName, table);
  const params = new URL(request.url).searchParams;

  let columns: string[] | null = null;
  const columnsParam = params.get("columns");
  if (columnsParam !== null) {
    columns = columnsParam
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }

  let onConflict: string[] | null = null;
  const onConflictParam = params.get("on_conflict");
  if (onConflictParam !== null) {
    onConflict = onConflictParam
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }

  return { ...base, method, columns, onConflict };
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
export function parseRpc(request: Request, schemaName: string, nameArg: string): ParsedRpc {
  const segments = nameArg.split("/").map((segment) => decodeURIComponent(segment));
  const fn = segments[0] ?? "";
  const pathArgs = segments.slice(1);

  const url = new URL(request.url);
  const params = url.searchParams;
  const select = parseSelect(params.get("select") ?? "*");
  const prefer = parsePrefer(request.headers.get("prefer"));
  const order = params.get("order") ? parseOrderTerms(params.get("order")!) : [];
  const limit = parseOptionalSize(params.get("limit"), "limit");
  const offset = parseOptionalSize(params.get("offset"), "offset");

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
    profile: request.headers.get("accept-profile") ?? undefined,
    ranged: false,
    prefer,
    params: prefer.params,
    bulkArgs: null,
    queryArgs,
    readOnly: false,
  };
}
