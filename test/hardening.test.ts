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
  create role anon nologin;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role write_only nologin;
exception when duplicate_object then null;
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
-- Auto-updatable view with no visible rows, for view-write policy tests.
create view items_readonly as select id, name from items where id < 0;
grant select on items_readonly to anon, authenticated;

insert into items (name) values ('a'), ('b'), ('c');
grant select, insert, update, delete on all tables in schema hard to anon, authenticated;
grant usage, select on all sequences in schema hard to anon, authenticated;

-- A table the authenticated role has no privileges on, to exercise the
-- insufficient_privilege (42501) mapping. Created after the blanket grant.
create table locked (id serial primary key, name text not null);
grant select on locked to anon;

-- Write-only endpoint role: it can insert/update/delete but cannot select the
-- value column. Minimal writes must not add hidden RETURNING requirements.
create table write_only_items (id serial primary key, name text not null);
grant usage on schema hard to write_only;
grant insert, delete on write_only_items to write_only;
grant update (name) on write_only_items to write_only;
grant select (id) on write_only_items to write_only;
grant usage, select on sequence write_only_items_id_seq to write_only;

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

  const call = (path: string, init?: RequestInit, pgbase = undefined as any) =>
    (pgbase ?? make).handler(
      new Request(`http://localhost/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers as any) },
      }),
    );

  let make: ReturnType<typeof createPgbase>;

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
    make = createPgbase(base as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  // -- Tier 1.2: maxRows caps RPC --------------------------------------------
  test("maxRows caps SETOF RPC results", async () => {
    const capped = createPgbase({ ...base, maxRows: 2 } as any);
    const res = await call("/rpc/many_rows?select=id", { method: "POST", body: JSON.stringify({ n: 5 }) }, capped);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[]).length).toBe(2);
  });

  test("the default maxRows cap is 1000", async () => {
    const itemCount = Number((await client.query("select count(*)::int as n from hard.items")).rows[0].n);
    const n = Math.ceil(1001 / itemCount);
    const res = await call("/rpc/many_rows?select=id", {
      method: "POST",
      body: JSON.stringify({ n }),
    });
    expect(((await res.json()) as any[]).length).toBe(1000);
  });

  test("RPC count is a real count, not the row count", async () => {
    const capped = createPgbase({ ...base, maxRows: 2 } as any);
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

  test("unfiltered view writes require an explicit opt-in", async () => {
    const guarded = await call("/items_readonly", { method: "DELETE" });
    expect(guarded.status).toBe(400);

    const enabled = createPgbase({ ...base, allowUnfilteredViewWrites: true } as any);
    const allowed = await call("/items_readonly", { method: "DELETE" }, enabled);
    expect(allowed.status).toBe(204);
  });

  // -- Tier 2: body size limit -----------------------------------------------
  test("oversized body returns 413", async () => {
    const small = createPgbase({ ...base, maxBodyBytes: 10 } as any);
    const res = await call("/items", { method: "POST", body: JSON.stringify({ name: "way too long" }) }, small);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).code).toBe("PGRST113");
  });

  test("body at the limit passes", async () => {
    const body = JSON.stringify({ name: "ok" });
    const exact = createPgbase({ ...base, maxBodyBytes: body.length } as any);
    const res = await call("/items", { method: "POST", body }, exact);
    expect(res.status).toBe(204);
  });

  test("body limit counts UTF-8 bytes, not JavaScript characters", async () => {
    const body = JSON.stringify({ name: "💥" });
    const limit = body.length + 1;
    expect(new TextEncoder().encode(body).byteLength > limit).toBe(true);
    const small = createPgbase({ ...base, maxBodyBytes: limit } as any);
    const res = await call("/items", { method: "POST", body }, small);
    expect(res.status).toBe(413);
  });

  // -- Tier 2: error verbosity ------------------------------------------------
  test("errorVerbosity minimal drops details/hint", async () => {
    const minimal = createPgbase({ ...base, errorVerbosity: "minimal" } as any);
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
    const withTimeout = createPgbase({ ...base, settings: { statement_timeout: "4s" } } as any);
    const res = await call("/rpc/current_timeout", { method: "POST", body: "{}" }, withTimeout);
    expect(await res.json()).toEqual(["4s"]);
  });

  // -- Tier 1.1: anonRole semantics ------------------------------------------
  test("no session falls back to anonRole", async () => {
    const noSession = createPgbase({ ...base, getSession: undefined } as any);
    const res = await call("/items?select=name", {}, noSession);
    expect(res.status).toBe(200);
  });

  // -- PostgREST 42501 mapping (insufficient_privilege) ----------------------
  test("42501 is 403 for authenticated and 401 for anon", async () => {
    // `authenticated` (the default session) has no privileges on `locked`.
    const authed = await call("/locked", { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(authed.status).toBe(403);
    expect(((await authed.json()) as any).code).toBe("42501");

    const anon = createPgbase({ ...base, getSession: undefined } as any);
    const anonRes = await call("/locked", { method: "POST", body: JSON.stringify({ name: "x" }) }, anon);
    expect(anonRes.status).toBe(401);
    expect(((await anonRes.json()) as any).code).toBe("42501");
  });

  test("malformed getSession results are rejected instead of using the connection role", async () => {
    const malformed = createPgbase({ ...base, getSession: () => ({ role: "" }) } as any);
    const res = await call("/items?select=id", {}, malformed);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).code).toBe("PGRST500");
  });

  test("an onError hook failure does not reject the handler", async () => {
    const guarded = createPgbase({ ...base, onError: () => { throw new Error("logging failed"); } } as any);
    const res = await call("/items?select=id", { headers: { cookie: "broken=%" } }, guarded);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).code).toBe("PGRST500");
  });

  test("a failed schema introspection is not cached forever", async () => {
    let failOnce = true;
    const flakyDb = db.withPlugin({
      transformQuery(args) {
        if (failOnce) {
          failOnce = false;
          throw new Error("temporary catalog connection failure");
        }
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const retryable = createPgbase({ ...base, database: flakyDb } as any);
    let failed = false;
    try {
      await retryable.schema();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await retryable.schema()).tables.has("items")).toBe(true);
  });

  test("minimal writes do not require SELECT privileges on returned columns", async () => {
    const writeOnly = createPgbase({ ...base, getSession: () => ({ role: "write_only" }) } as any);
    const inserted = await call("/write_only_items", {
      method: "POST",
      body: JSON.stringify({ name: "before" }),
    }, writeOnly);
    expect(inserted.status).toBe(204);

    const updated = await call("/write_only_items?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ name: "after" }),
    }, writeOnly);
    expect(updated.status).toBe(204);

    const deleted = await call("/write_only_items?id=eq.1", { method: "DELETE" }, writeOnly);
    expect(deleted.status).toBe(204);
    expect((await client.query("select count(*)::int as n from hard.write_only_items")).rows[0].n).toBe(0);
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

  test("PgbaseError is thrown for unknown columns", async () => {
    const res = await call("/items?select=nope");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("PGRST204");
  });
});
