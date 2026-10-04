import { sql, type Kysely } from "kysely";
import type {
  PgbaseColumn,
  PgbaseExposed,
  PgbaseForeignKey,
  PgbaseFunction,
  PgbaseFunctionArg,
  PgbaseRelation,
  PgbaseSchema,
} from "../types.ts";
import { PgbaseError } from "../errors.ts";

interface RelationRow {
  name: string;
  kind: string;
  oid: number;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: string | number;
}

interface KeyRow {
  constraint_name: string;
  table_name: string;
  column_name: string;
  contype: string;
  ord: number;
}

interface FkRow {
  constraint_name: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  ord: number;
}

interface RawFunctionRow {
  name: string;
  kind: string;
  volatility: string;
  returns_set: boolean;
  security_definer: boolean;
  return_type: string;
  return_relation: string | null;
  /** text[] — the driver parses these into arrays. */
  arg_names: string[] | null;
  /** "char"[] — node-postgres returns this as the raw `{t,t}` string. */
  arg_modes: string | string[] | null;
  arg_defaults: number;
  arg_defs: string;
}

/** Normalize a Postgres array literal (`{t,t}`, `{a,b}`) or array into a string[]. */
function toStringArray(value: string | string[] | null): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  const trimmed = value.trim();
  if (trimmed === "{}") return [];
  if (!trimmed.startsWith("{")) return [trimmed];
  const inner = trimmed.slice(1, -1);
  if (inner === "") return [];
  return inner.split(",").map((entry) => unquoteArrayEntry(entry));
}

function unquoteArrayEntry(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

const RELKIND: Record<string, PgbaseRelation["kind"]> = {
  r: "table",
  v: "view",
  m: "materialized_view",
  p: "partitioned_table",
  f: "foreign_table",
};

function isExposed(name: string, kind: PgbaseRelation["kind"], exposed: PgbaseExposed | false | undefined): boolean {
  if (exposed === false) return false;
  if (exposed === undefined) return true;
  const isView = kind === "view" || kind === "materialized_view";
  const list = isView ? exposed.views : exposed.tables;
  if (list === undefined) return false;
  return list.includes(name);
}

/**
 * Introspect the exposed schema once and cache the result. Uses `pg_catalog`
 * so it works regardless of `information_schema` visibility and composite keys
 * are read in the correct order.
 */
export async function introspect(
  db: Kysely<any>,
  schemaName: string,
  exposed: PgbaseExposed | false | undefined,
): Promise<PgbaseSchema> {
  const relationRows = await sql<RelationRow>`
    select c.relname as name, c.relkind as kind, c.oid as oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schemaName}
      and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and not c.relispartition
    order by c.relname
  `.execute(db);

  const columnRows = await sql<ColumnRow>`
    select table_name, column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
    from information_schema.columns
    where table_schema = ${schemaName}
    order by table_name, ordinal_position
  `.execute(db);

  const keyRows = await sql<KeyRow>`
    select con.conname as constraint_name,
           rel.relname as table_name,
           att.attname as column_name,
           con.contype as contype,
           k.ord as ord
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype in ('p', 'u') and nsp.nspname = ${schemaName}
    order by con.conname, k.ord
  `.execute(db);

  const fkRows = await sql<FkRow>`
    select con.conname as constraint_name,
           rel.relname as from_table,
           att.attname as from_column,
           frel.relname as to_table,
           fatt.attname as to_column,
           k.ord as ord
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_class frel on frel.oid = con.confrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join lateral unnest(con.confkey) with ordinality as fk(attnum, ord) on fk.ord = k.ord
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = fk.attnum
    where con.contype = 'f' and nsp.nspname = ${schemaName}
    order by con.conname, k.ord
  `.execute(db);

  const columnsByTable = new Map<string, PgbaseColumn[]>();
  for (const row of columnRows.rows) {
    const list = columnsByTable.get(row.table_name) ?? [];
    list.push({
      name: row.column_name,
      type: row.data_type,
      udt: row.udt_name,
      nullable: row.is_nullable === "YES",
      default: row.column_default,
      position: Number(row.ordinal_position),
      isArray: row.data_type === "ARRAY",
    });
    columnsByTable.set(row.table_name, list);
  }

  // Group key constraints preserving column order.
  const pkByTable = new Map<string, string[]>();
  const uniqueByTable = new Map<string, string[]>();
  for (const row of keyRows.rows) {
    const map = row.contype === "p" ? pkByTable : uniqueByTable;
    const list = map.get(row.table_name) ?? [];
    list.push(row.column_name);
    map.set(row.table_name, list);
  }

  const foreignKeys: PgbaseForeignKey[] = [];
  const fkByConstraint = new Map<string, PgbaseForeignKey>();
  for (const row of fkRows.rows) {
    let fk = fkByConstraint.get(row.constraint_name);
    if (!fk) {
      fk = {
        constraint: row.constraint_name,
        fromTable: row.from_table,
        fromColumns: [],
        toTable: row.to_table,
        toColumns: [],
      };
      fkByConstraint.set(row.constraint_name, fk);
      foreignKeys.push(fk);
    }
    fk.fromColumns.push(row.from_column);
    fk.toColumns.push(row.to_column);
  }

  const relations: PgbaseRelation[] = [];
  const tables = new Map<string, PgbaseRelation>();
  for (const row of relationRows.rows) {
    const kind = RELKIND[row.kind] ?? "table";
    if (!isExposed(row.name, kind, exposed)) continue;
    const columns = columnsByTable.get(row.name) ?? [];
    relations.push({
      name: row.name,
      schema: schemaName,
      kind,
      columns,
      columnMap: new Map(columns.map((c) => [c.name, c])),
      primaryKey: pkByTable.get(row.name) ?? null,
      uniques: uniqueByTable.has(row.name) ? [uniqueByTable.get(row.name)!] : [],
    });
  }
  for (const relation of relations) tables.set(relation.name, relation);

  const functions = await introspectFunctions(db, schemaName);

  return { schema: schemaName, relations, tables, foreignKeys, functions };
}

function parseArgs(row: RawFunctionRow): { args: PgbaseFunctionArg[]; columns: Array<{ name: string }> } {
  const names = row.arg_names;
  const rawModes = toStringArray(row.arg_modes);
  const modes = rawModes ?? new Array(names?.length ?? 0).fill("i");
  const args: PgbaseFunctionArg[] = [];
  const columns: Array<{ name: string }> = [];

  for (let i = 0; i < (names?.length ?? 0); i++) {
    const name = names![i];
    if (!name) continue;
    const mode = modes[i] ?? "i";
    if (mode === "o" || mode === "t") {
      columns.push({ name });
      continue;
    }
    args.push({ name, type: "", mode, hasDefault: false });
  }

  // `pronargdefaults` counts the trailing input args that have defaults.
  const withDefaults = row.arg_defaults ?? 0;
  const start = args.length - withDefaults;
  for (let i = 0; i < args.length; i++) {
    if (i >= start) args[i]!.hasDefault = true;
  }
  return { args, columns };
}

async function introspectFunctions(db: Kysely<any>, schemaName: string): Promise<Map<string, PgbaseFunction>> {
  const rows = await sql<RawFunctionRow>`
    select p.proname as name,
           p.prokind as kind,
           p.provolatile as volatility,
           p.proretset as returns_set,
           p.prosecdef as security_definer,
           rt.typname as return_type,
           rc.relname as return_relation,
           p.proargnames as arg_names,
           p.proargmodes as arg_modes,
           p.pronargdefaults as arg_defaults,
           pg_get_function_arguments(p.oid) as arg_defs
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type rt on rt.oid = p.prorettype
    left join pg_class rc on rc.oid = rt.typrelid
    where n.nspname = ${schemaName}
      and p.prokind in ('f', 'p')
    order by p.proname
  `.execute(db);

  const functions = new Map<string, PgbaseFunction>();
  for (const row of rows.rows as unknown as RawFunctionRow[]) {
    const { args, columns } = parseArgs(row);
    const fn: PgbaseFunction = {
      schema: schemaName,
      name: row.name,
      kind: row.kind,
      volatility: row.volatility,
      returnsSet: row.returns_set === true,
      returnsTable: row.kind === "p" || row.return_relation != null,
      returnType: row.return_type,
      returnRelation: row.return_relation,
      securityDefiner: row.security_definer === true,
      args,
      requiredArgCount: args.filter((arg) => !arg.hasDefault).length,
      columns,
    };
    functions.set(fn.name, fn);
  }
  return functions;
}
