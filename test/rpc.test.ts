import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "./expect.ts";
import { Client, Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createPgbase } from "../src/index.ts";

const DATABASE_URL = process.env.PGB_TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

const SETUP_SQL = `
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists api;

drop table if exists api.books cascade;
drop table if exists api.authors cascade;

create table api.authors (
  id serial primary key,
  name text not null
);
create table api.books (
  id serial primary key,
  author_id int not null references api.authors(id),
  title text not null,
  published boolean not null default false,
  views int not null default 0
);

-- Scalar function with a default argument.
create or replace function api.add(a int, b int default 1) returns int
  language sql immutable as $$ select a + b $$;

-- Scalar function that reflects the caller's role (session-aware).
create or replace function api.whoami() returns text
  language sql stable as $$ select current_user $$;

-- SETOF <table> returning function.
create or replace function api.search_books(term text) returns setof api.books
  language sql stable as $$ select * from api.books where title ilike '%' || term || '%' $$;

-- TABLE-returning (anonymous record / OUT columns).
create or replace function api.book_stats()
  returns table (published boolean, total bigint)
  language sql stable as $$
    select published, count(*) from api.books group by published order by published
  $$;

-- Volatile function: must be POST-only.
create or replace function api.bump_views(book_id int) returns int
  language sql volatile as $$
    update api.books set views = views + 1 where id = book_id returning views
  $$;

-- Procedure.
create or replace procedure api.noop() language sql as $$ select 1 $$;

grant usage on schema api to anon, authenticated;
grant select, insert, update, delete on all tables in schema api to anon, authenticated;
grant usage, select on all sequences in schema api to anon, authenticated;
grant execute on all functions in schema api to anon, authenticated;

insert into api.authors (id, name) values (1, 'Ada'), (2, 'Bob');
insert into api.books (id, author_id, title, published, views) values
  (1, 1, 'Alpha', true, 10),
  (2, 1, 'Beta', false, 20),
  (3, 2, 'Gamma', true, 30);
`;

suite("RPC against Postgres", () => {
  let client: Client;
  let pool: Pool;
  let db: Kysely<any>;
  let pgbase: ReturnType<typeof createPgbase>;

  const call = (path: string, init?: RequestInit) =>
    pgbase.handler(
      new Request(`http://localhost/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers as any) },
      }),
    );

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(SETUP_SQL);

    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    pgbase = createPgbase({
      database: db,
      schemaName: "api",
      basePath: "/api",
      getSession: (request: Request) => ({
        role: request.headers.get("x-role") ?? "authenticated",
      }),
    } as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  test("scalar function via POST body returns the bare value", async () => {
    const res = await call("/rpc/add", { method: "POST", body: JSON.stringify({ a: 2, b: 3 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([5]);
  });

  test("scalar function honours defaults and query args", async () => {
    const viaQuery = await call("/rpc/add?a=4");
    expect(await viaQuery.json()).toEqual([5]);

    const viaBody = await call("/rpc/add", { method: "POST", body: JSON.stringify({ a: 10 }) });
    expect(await viaBody.json()).toEqual([11]);
  });

  test("scalar function via positional path args", async () => {
    const res = await call("/rpc/add/7/8");
    expect(await res.json()).toEqual([15]);
  });

  test("stable scalar function is callable with GET and sees the role", async () => {
    const res = await call("/rpc/whoami", { headers: { "x-role": "anon" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["anon"]);
  });

  test("volatile function rejects GET with 405", async () => {
    const res = await call("/rpc/bump_views?book_id=1");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  test("SETOF <table> supports select, filter and order", async () => {
    const res = await call("/rpc/search_books?term=a&select=title,views&order=views.desc", {
      method: "POST",
      body: JSON.stringify({ term: "a" }),
    });
    const body = (await res.json()) as any[];
    expect(body.map((b) => b.title)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  test("SETOF filters apply to the function result", async () => {
    const res = await call("/rpc/search_books?select=title&published=eq.true&order=title.asc", {
      method: "POST",
      body: JSON.stringify({ term: "a" }),
    });
    expect(((await res.json()) as any[]).map((b) => b.title)).toEqual(["Alpha", "Gamma"]);
  });

  test("TABLE-returning function projects declared columns", async () => {
    const res = await call("/rpc/book_stats?order=published.asc", {
      method: "POST",
      body: "{}",
    });
    const body = (await res.json()) as any[];
    expect(body).toEqual([
      { published: false, total: "1" },
      { published: true, total: "2" },
    ]);
  });

  test("volatile function mutates and returns a value", async () => {
    const res = await call("/rpc/bump_views", {
      method: "POST",
      body: JSON.stringify({ book_id: 1 }),
    });
    expect(await res.json()).toEqual([11]);
  });

  test("Prefer: params=bulk invokes once per array element", async () => {
    const res = await call("/rpc/add", {
      method: "POST",
      body: JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]),
      headers: { prefer: "params=bulk" },
    });
    expect(await res.json()).toEqual([2, 3, 4]);
  });

  test("missing required argument is 404 PGRST202", async () => {
    const res = await call("/rpc/add", { method: "POST", body: JSON.stringify({ b: 3 }) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("PGRST202");
  });

  test("unknown function is 404 PGRST202", async () => {
    const res = await call("/rpc/nope", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("PGRST202");
  });

  test("singular accept returns the bare object/value", async () => {
    const res = await call("/rpc/book_stats", {
      method: "POST",
      body: "{}",
      headers: { accept: "application/vnd.pgrst.object+json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ published: false, total: "1" });
  });
});
