/** AST produced by the PostgREST query-string parser. */

export interface SelectColumn {
  kind: "column";
  column: string;
  alias?: string;
  cast?: string;
  jsonPath?: string[];
  star?: boolean;
}

export interface SelectEmbed {
  kind: "embed";
  relation: string;
  alias?: string;
  hint?: string;
  inner: boolean;
  spread: boolean;
  children: SelectNode[];
  /** Path used to match dotted embed params, e.g. `orders.customer`. */
  path: string;
}

export type SelectNode = SelectColumn | SelectEmbed;

export interface OpFilter {
  kind: "op";
  column: string;
  jsonPath?: string[];
  cast?: string;
  op: string;
  negate: boolean;
  value: unknown;
  tsConfig?: string;
}

export interface LogicFilter {
  kind: "logic";
  op: "and" | "or";
  negate: boolean;
  children: FilterNode[];
}

export type FilterNode = OpFilter | LogicFilter;

export interface OrderTerm {
  column: string;
  direction: "asc" | "desc";
  nulls?: "first" | "last";
  jsonPath?: string[];
  cast?: string;
}

export interface EmbedParams {
  filters: FilterNode[];
  order: OrderTerm[];
  limit?: number;
  offset?: number;
}

export interface ParsedRequest {
  table: string;
  schema: string;
  select: SelectNode[];
  filters: FilterNode[];
  order: OrderTerm[];
  limit?: number;
  offset?: number;
  embeds: Map<string, EmbedParams>;
  singular: boolean;
  count: "exact" | "planned" | "estimated" | null;
  format: "json" | "csv";
  profile?: string;
  /** Canonical (sorted, re-encoded) query string, used for `Content-Location`. */
  canonicalQuery: string;
  /** True when a valid `Range` header was parsed (GET/HEAD only). */
  ranged: boolean;
  prefer: PreferOptions;
}

export interface PreferOptions {
  /** `null` when the client did not ask for a specific representation. */
  return: "minimal" | "representation" | "headers-only" | null;
  count: "exact" | "planned" | "estimated" | null;
  resolution: "merge-duplicates" | "ignore-duplicates" | null;
  /** `missing=default` applies defaults; `missing=null` is the default behavior. */
  missing: "default" | "null" | null;
  handling: "strict" | "lenient" | null;
  params: "single-object" | "bulk";
  /** `Prefer: max-affected=N`; enforced for PATCH/DELETE/RPC with handling=strict. */
  maxAffected: number | null;
  /** Unrecognized preference tokens; rejected only with handling=strict. */
  invalid: string[];
}

export type WriteMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export interface ParsedRpc extends ParsedRequest {
  fn: string;
  /** `single-object` (default, body is the argument object) or `bulk` (body is an array). */
  params: "single-object" | "bulk";
  /** One arg set per element for `params=bulk`. */
  bulkArgs: Array<Record<string, unknown>> | null;
  /** Every non-control query-string param, split into args vs. filters at call time. */
  queryArgs: Record<string, unknown>;
  /** Read-only funcs (immutable/stable) allow GET; volatile funcs require POST. */
  readOnly: boolean;
}

export interface ParsedMutation extends ParsedRequest {
  method: WriteMethod;
  /** Vertical filtering: restrict which columns may be written/returned. */
  columns: string[] | null;
  /** Conflict target for upserts, from `?on_conflict=`. */
  onConflict: string[] | null;
  /** True when `limit`/`offset` query params applied; PUT rejects those. */
  rangeLimited: boolean;
}

