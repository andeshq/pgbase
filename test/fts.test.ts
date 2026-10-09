import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "./expect.ts";
import { Client, Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createPgbase } from "../src/index.ts";

/**
 * Full-text search across tables and views, mirroring PostgREST: non-`tsvector`
 * columns are wrapped in `to_tsvector` so text/json/jsonb columns work and both
 * sides of `@@` share the same text-search configuration.
 */
const DATABASE_URL = process.env.PGB_TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

const SETUP_SQL = `
do $$
begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;

drop schema if exists fts_schema cascade;
create schema fts_schema;
grant usage on schema fts_schema to anon, authenticated;
set search_path to fts_schema;

create table docs (
  id serial primary key,
  title text not null,
  body text not null,
  meta jsonb not null default '{}'::jsonb,
  tsv tsvector not null
);

insert into docs (title, body, meta, tsv) values
  ('Alpha', 'the quick brown fox', '{"tag":"fox"}', to_tsvector('english', 'the quick brown fox')),
  ('Beta',  'Katzen und Hunde',   '{"tag":"dog"}', to_tsvector('german',  'Katzen und Hunde'));

create view docs_view as select id, title, body, meta, tsv from docs;

grant select on all tables in schema fts_schema to anon, authenticated;
grant usage, select on all sequences in schema fts_schema to anon, authenticated;
`;

suite("full-text search", () => {
  let client: Client;
  let pool: Pool;
  let db: Kysely<any>;
  let pgbase: ReturnType<typeof createPgbase>;

  const call = (path: string) =>
    pgbase.handler(new Request(`http://localhost/rest${path}`));

  const titles = async (path: string): Promise<string[]> => {
    const res = await call(path);
    expect(res.status).toBe(200);
    return ((await res.json()) as any[]).map((row) => row.title);
  };

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(SETUP_SQL);

    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    pgbase = createPgbase({
      database: db,
      schemaName: "fts_schema",
      basePath: "/rest",
      getSession: () => ({ role: "authenticated" }),
    } as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  test("fts on a tsvector column is used directly", async () => {
    expect(await titles("/docs?select=title&tsv=fts.quick")).toEqual(["Alpha"]);
  });

  test("fts on a tsvector column honors the query language", async () => {
    expect(await titles("/docs?select=title&tsv=fts(german).Katz")).toEqual(["Beta"]);
  });

  test("fts on a text column wraps the column in to_tsvector", async () => {
    expect(await titles("/docs?select=title&body=fts.quick")).toEqual(["Alpha"]);
  });

  test("fts language applies to the text column, not just the query", async () => {
    // 'Katzen' stems to 'katz' under the German config; the default (English)
    // config would leave it as 'katzen' and match nothing.
    expect(await titles("/docs?select=title&body=fts(german).Katz")).toEqual(["Beta"]);
    expect(await titles("/docs?select=title&body=fts.Katz")).toEqual([]);
  });

  test("not.fts negates the match", async () => {
    expect(await titles("/docs?select=title&body=not.fts.quick&order=title")).toEqual(["Beta"]);
  });

  test("fts on a jsonb column wraps the column in to_tsvector", async () => {
    expect(await titles("/docs?select=title&meta=fts.fox")).toEqual(["Alpha"]);
    expect(await titles("/docs?select=title&meta=plfts.fox")).toEqual(["Alpha"]);
  });

  test("plainto, phraseto and websearch tsquery variants", async () => {
    expect(await titles("/docs?select=title&body=plfts.quick%20brown")).toEqual(["Alpha"]);
    expect(await titles("/docs?select=title&body=phfts.quick%20brown")).toEqual(["Alpha"]);
    expect(await titles("/docs?select=title&body=wfts.quick%20fox")).toEqual(["Alpha"]);
  });

  test("fts composes with or", async () => {
    expect(await titles("/docs?select=title&or=(body.fts.quick,meta.fts.dog)&order=title")).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  test("fts works through a view", async () => {
    expect(await titles("/docs_view?select=title&tsv=fts.quick")).toEqual(["Alpha"]);
    expect(await titles("/docs_view?select=title&body=fts(german).Katz")).toEqual(["Beta"]);
    expect(await titles("/docs_view?select=title&meta=fts.fox")).toEqual(["Alpha"]);
  });
});
