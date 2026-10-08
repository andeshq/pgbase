import { describe, test } from "node:test";
import { expect } from "./expect.ts";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { buildCountQuery, buildReadQuery, type ExecContext } from "../src/query/compile.ts";
import { parseRequest } from "../src/parse/request.ts";
import type { PgbaseForeignKey, PgbaseRelation, PgbaseSchema } from "../src/types.ts";

// A Kysely instance is only needed to *compile* SQL here; the pool is never used.
const db = new Kysely<any>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: "postgres://localhost:1/none" }) }),
});

function relation(name: string, columns: Array<[string, string]>, pk: string[] = ["id"]): PgbaseRelation {
  const cols = columns.map(([col, udt], i) => ({
    name: col,
    type: udt.startsWith("_") ? "ARRAY" : "USER-DEFINED",
    udt,
    nullable: true,
    default: null,
    position: i + 1,
    isArray: udt.startsWith("_"),
  }));
  return {
    name,
    schema: "public",
    kind: "table",
    columns: cols,
    columnMap: new Map(cols.map((c) => [c.name, c])),
    primaryKey: pk,
    uniques: [],
  };
}

const authors = relation("authors", [["id", "int4"], ["name", "text"]]);
const books = relation("books", [
  ["id", "int4"],
  ["author_id", "int4"],
  ["title", "text"],
  ["published", "bool"],
  ["meta", "jsonb"],
  ["tags", "_text"],
]);
const tags = relation("tags", [["id", "int4"], ["name", "text"]]);
const bookTags = relation("book_tags", [["book_id", "int4"], ["tag_id", "int4"]], []);

const foreignKeys: PgbaseForeignKey[] = [
  { constraint: "books_author_id_fkey", fromTable: "books", fromColumns: ["author_id"], toTable: "authors", toColumns: ["id"] },
  { constraint: "book_tags_book_id_fkey", fromTable: "book_tags", fromColumns: ["book_id"], toTable: "books", toColumns: ["id"] },
  { constraint: "book_tags_tag_id_fkey", fromTable: "book_tags", fromColumns: ["tag_id"], toTable: "tags", toColumns: ["id"] },
];

const relations = [authors, books, tags, bookTags];
const schema: PgbaseSchema = {
  schema: "public",
  relations,
  tables: new Map(relations.map((r) => [r.name, r])),
  foreignKeys,
  functions: new Map(),
};

function ctxFor(url: string): ExecContext {
  const request = parseRequest(new Request(url), "public", new URL(url).pathname.slice(1));
  return {
    db,
    schema,
    request,
    maxRows: Infinity,
    maxBodyBytes: Infinity,
    allowUnfilteredViewWrites: false,
  };
}

describe("SQL compilation", () => {
  test("filters, order, limit and json path", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/books?select=title&published=eq.true&meta->>isbn=eq.123&order=title.desc.nullslast&limit=5&offset=2"),
    ).compile();
    expect(compiled.sql).toContain('"books"."published" =');
    expect(compiled.sql).toContain("->>");
    expect(compiled.sql).toContain("order by");
    expect(compiled.sql).toContain("desc nulls last");
    expect(compiled.sql).toContain("limit");
    expect(compiled.sql).toContain("offset");
    expect(compiled.parameters).toContain("isbn");
  });

  test("like and ilike treat * as a wildcard alias for %", () => {
    const like = buildReadQuery(ctxFor("http://localhost/books?title=like.*Al*")).compile();
    expect(like.parameters).toContain("%Al%");

    const ilike = buildReadQuery(ctxFor("http://localhost/books?title=ilike.*al*")).compile();
    expect(ilike.parameters).toContain("%al%");
  });

  test("to-one embed uses jsonObjectFrom", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/books?select=title,author:authors(name)"),
    ).compile();
    expect(compiled.sql).toContain("to_json");
    expect(compiled.sql).toContain('"authors"."id" = "books"."author_id"');
  });

  test("to-one spread projects child columns into the parent row", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/books?select=title,...author:authors(name)"),
    ).compile();
    expect(compiled.sql).toContain('(select "authors"."name" as "name"');
    expect(compiled.sql).toContain('as "name"');
    expect(compiled.sql.includes("json_build_object")).toBe(false);
  });

  test("spread rejects to-many relationships and duplicate output names", () => {
    expect(() => buildReadQuery(ctxFor("http://localhost/authors?select=...books(title)")))
      .toThrow(/Spread embedding is only supported for to-one/);
    expect(() => buildReadQuery(ctxFor("http://localhost/books?select=id,...authors(id)")))
      .toThrow(/conflicts with another selected column/);
  });

  test("to-many embed uses jsonArrayFrom", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/authors?select=name,books(title)&books.published=eq.true"),
    ).compile();
    expect(compiled.sql).toContain("json_agg");
    expect(compiled.sql).toContain('"books"."author_id" = "authors"."id"');
    expect(compiled.sql).toContain('"books"."published"');
  });

  test("many-to-many embed joins the junction table", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/books?select=title,tags(name)"),
    ).compile();
    expect(compiled.sql).toContain("inner join");
    expect(compiled.sql).toContain('"book_tags"');
    expect(compiled.sql).toContain('"book_tags"."tag_id" = "tags"."id"');
    expect(compiled.sql).toContain('"book_tags"."book_id" = "books"."id"');
  });

  test("!inner adds an exists clause", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/authors?select=name,books!inner(title)&books.published=eq.true"),
    ).compile();
    expect(compiled.sql).toContain("exists");
  });

  test("logic operators compile to and/or", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/books?or=(title.eq.a,title.eq.b)"),
    ).compile();
    expect(compiled.sql).toMatch(/\bor\b/i);
  });

  test("array operators use @>", () => {
    const compiled = buildReadQuery(
      ctxFor("http://localhost/books?tags=cs.{a,b}"),
    ).compile();
    expect(compiled.sql).toContain("@>");
  });

  test("count query selects countAll", () => {
    const compiled = buildCountQuery(ctxFor("http://localhost/books?published=eq.true")).compile();
    expect(compiled.sql).toContain("count(*)");
  });

  test("unknown column throws PGRST204", () => {
    expect(() => buildReadQuery(ctxFor("http://localhost/books?select=nope"))).toThrow(/PGRST204|Could not find/);
  });
});
