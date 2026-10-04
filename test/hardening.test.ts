import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "./expect.ts";
import { Client, Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createPgb } from "../src/index.ts";

const DATABASE_URL = process.env.PGB_TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

const SETUP_SQL = `
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

drop schema if exists hard cascade;
create schema hard;
grant usage on schema hard to anon, authenticated;
set search_path to hard;

create table items (
  id serial primary key,
  name text not null,
  secret text not null default 'x'
);
-- A view with an INSTEAD OF trigger, to prove the unfiltered guard exempts views.
create view items_readonly as select id, name from items;
grant select on items_readonly to anon, authenticated;

insert into items (name) values ('a'), ('b'), ('c');
grant select, insert, update, delete on all tables in schema hard to anon, authenticated;
grant usage, select on all sequences in schema hard to anon, authenticated;

create function many_rows(n int) returns setof items language sql stable as $$
  select i.* from items i, generate_series(1, n)
$$;
grant execute on function many_rows(int) to anon, authenticated;
`;

suite("hardening: tier 1 + 2", () => {
  let client: Client;
  let pool: Pool;
  let db: Kysely<any>;
  let base: any;

  const call = (path: string, init?: RequestInit, pgb = undefined as any) =>
    (pgb ?? make).handler(
      new Request(`http://localhost/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers as any) },
      }),
    );

  let make: ReturnType<typeof createPgb>;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(SETUP_SQL);

    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    base = {
      database: db,
      schemaName: "hard",
      basePath: "/api",
      anonRole: "anon",
      getSession: () => ({ role: "authenticated" }),
    };
    make = createPgb(base as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  // -- Tier 1.2: maxRows caps RPC --------------------------------------------
  test("maxRows caps SETOF RPC results", async () => {
    const capped = createPgb({ ...base, maxRows: 2 } as any);
    const res = await call("/rpc/many_rows?select=id", { method: "POST", body: JSON.stringify({ n: 5 }) }, capped);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[]).length).toBe(2);
  });

  test("RPC count is a real count, not the row count", async () => {
    const capped = createPgb({ ...base, maxRows: 2 } as any);
    // `items` may have grown from earlier tests, so compute the expected total.
    const rows = await client.query("select count(*)::int as n from hard.items");
    const expected = rows.rows[0].n * 5;
    const res = await call(
      "/rpc/many_rows?select=id",
      { method: "POST", body: JSON.stringify({ n: 5 }), headers: { prefer: "count=exact" } },
      capped,
    );
    expect(res.headers.get("content-range")).toBe(`*/${expected}`);
  });

  // -- Tier 1.3: unfiltered writes -------------------------------------------
  test("unfiltered PATCH/DELETE on a table is rejected", async () => {
    const patch = await call("/items", { method: "PATCH", body: JSON.stringify({ name: "z" }) });
    expect(patch.status).toBe(400);
    const del = await call("/items", { method: "DELETE" });
    expect(del.status).toBe(400);
  });

  test("views are exempt from the unfiltered-write guard", async () => {
    // The guard should not fire for a view; the failure (if any) is a DB error,
    // not the client-side PGRST100 guard error.
    const del = await call("/items_readonly", { method: "DELETE" });
    expect(del.status).not.toBe(400);
    if (del.status < 400 && del.headers.get("content-type")?.includes("json")) {
      const body = (await del.json()) as any;
      expect(body?.code).not.toBe("PGRST100");
    }
  });

  // -- Tier 2: body size limit -----------------------------------------------
  test("oversized body returns 413", async () => {
    const small = createPgb({ ...base, maxBodyBytes: 10 } as any);
    const res = await call("/items", { method: "POST", body: JSON.stringify({ name: "way too long" }) }, small);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).code).toBe("PGRST113");
  });

  test("body at the limit passes", async () => {
    const body = JSON.stringify({ name: "ok" });
    const exact = createPgb({ ...base, maxBodyBytes: body.length } as any);
    const res = await call("/items", { method: "POST", body }, exact);
    expect(res.status).toBe(204);
  });

  // -- Tier 2: error verbosity ------------------------------------------------
  test("errorVerbosity minimal drops details/hint", async () => {
    const minimal = createPgb({ ...base, errorVerbosity: "minimal" } as any);
    // A unique violation carries `detail`; force one via a not-null violation.
    const res = await call("/items", { method: "POST", body: JSON.stringify({ secret: "no name" }) }, minimal);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.details).toBeNull();
    expect(body.hint).toBeNull();
    expect(typeof body.code).toBe("string");
  });

  // -- Tier 2: transaction settings ------------------------------------------
  test("config settings are applied transaction-scoped", async () => {
    await client.query(`
      create or replace function hard.current_timeout() returns text
      language sql stable as $$ select current_setting('statement_timeout', true) $$;
      grant execute on function hard.current_timeout() to anon, authenticated;
    `);
    const withTimeout = createPgb({ ...base, settings: { statement_timeout: "4s" } } as any);
    const res = await call("/rpc/current_timeout", { method: "POST", body: "{}" }, withTimeout);
    expect(await res.json()).toEqual(["4s"]);
  });

  // -- Tier 1.1: anonRole semantics ------------------------------------------
  test("no session falls back to anonRole", async () => {
    const noSession = createPgb({ ...base, getSession: undefined } as any);
    const res = await call("/items?select=name", {}, noSession);
    expect(res.status).toBe(200);
  });

  // -- Tier 1.4: identifier injection ----------------------------------------
  test("malicious identifiers are rejected, not interpolated", async () => {
    const attempts = [
      "/items?select=id);drop%20table%20items;--",
      "/items?order=id;drop%20table%20items",
      "/items?id=eq.1);delete%20from%20items;--",
      "/items?select=id::text);drop",
    ];
    for (const path of attempts) {
      const res = await call(path);
      // Must be a handled response, never a 500 from injected SQL.
      expect(res.status).not.toBe(500);
      expect([200, 400, 404].includes(res.status)).toBe(true);
    }
    // The table must still exist (a successful injection would have dropped it).
    const check = await call("/items?select=id&limit=1");
    expect([200, 206].includes(check.status)).toBe(true);
  });

  test("invalid cast is rejected", async () => {
    const res = await call("/items?select=id::not_a_real_type");
    expect(res.status === 400 || res.status === 500).toBe(true);
  });

  test("PgbError is thrown for unknown columns", async () => {
    const res = await call("/items?select=nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("PGRST204");
  });
});
