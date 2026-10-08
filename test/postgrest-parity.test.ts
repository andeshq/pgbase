import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "./expect.ts";
import { Client, Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createPgbase } from "../src/index.ts";

/**
 * Behaviors borrowed from PostgREST's spec suite (`test/spec/Feature/Query/*`)
 * to lock in API compatibility: insert/update/upsert/delete semantics, range
 * and preference handling, and rollback guarantees.
 *
 * Each test names the PostgREST spec context it comes from.
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

drop schema if exists parity cascade;
create schema parity;
grant usage on schema parity to anon, authenticated;
set search_path to parity;

create table items (
  id serial primary key,
  name text not null default 'default'
);
create table no_pk (a text, b text);
create table compound (
  a int not null,
  b int not null,
  value text,
  primary key (a, b)
);
create table tiobe (name text primary key, rank int);
create table range_items (id int primary key, label text not null);
create table bulk_items (id int primary key, name text not null);
create table ma_items (id int primary key, name text not null);
create table authors (id serial primary key, name text not null);
create table books (
  id serial primary key,
  author_id int not null references authors(id),
  title text not null
);

create function scalar_answer() returns int language sql immutable as $$ select 42 $$;
create function many_items(n int) returns setof range_items
  language sql stable as $$ select * from range_items order by id limit n $$;
create function volatile_fn() returns int language plpgsql volatile as $$ begin return 1; end $$;

create view read_only_view as select count(*)::int as n from no_pk;

grant select, insert, update, delete on all tables in schema parity to anon, authenticated;
grant usage, select on all sequences in schema parity to anon, authenticated;
grant execute on all functions in schema parity to anon, authenticated;

insert into items (name) values ('one'), ('two'), ('three');
insert into compound values (1, 1, 'one-one'), (1, 2, 'one-two');
insert into tiobe values ('Java', 1), ('C', 2);
insert into range_items values (1, 'r1'), (2, 'r2'), (3, 'r3'), (4, 'r4'), (5, 'r5');
insert into ma_items values (1, 'm1'), (2, 'm2'), (3, 'm3');
insert into authors (name) values ('Ada');
insert into books (author_id, title) values (1, 'Alpha');
`;

suite("PostgREST parity", () => {
  let client: Client;
  let pool: Pool;
  let db: Kysely<any>;
  let pgbase: ReturnType<typeof createPgbase>;

  const call = (path: string, init?: RequestInit) =>
    pgbase.handler(
      new Request(`http://localhost/rest${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers as any) },
      }),
    );

  const json = (res: Response): Promise<any> => res.json() as Promise<any>;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(SETUP_SQL);

    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    pgbase = createPgbase({
      database: db,
      schemaName: "parity",
      basePath: "/rest",
      getSession: () => ({ role: "authenticated" }),
    } as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  // -- InsertSpec -----------------------------------------------------------

  describe("insert (InsertSpec)", () => {
    test("POST [] inserts nothing and returns 201 with an empty representation", async () => {
      const res = await call("/items", {
        method: "POST",
        body: "[]",
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(201);
      expect(await json(res)).toEqual([]);
      expect(res.headers.get("content-range")).toBe("*/*");
    });

    test("POST [] with merge-duplicates is 200 because nothing was inserted", async () => {
      const res = await call("/items", {
        method: "POST",
        body: "[]",
        headers: { prefer: "return=representation, resolution=merge-duplicates" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
    });

    test("bulk arrays must have uniform keys", async () => {
      const res = await call("/items", {
        method: "POST",
        body: JSON.stringify([{ name: "u1" }, { name: "u2", other: 1 }]),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe("PGRST102");
      expect(body.message).toBe("All object keys must match");
    });

    test("bulk arrays reject elements that are not objects", async () => {
      const res = await call("/items", {
        method: "POST",
        body: JSON.stringify([{ name: "x" }, 1, "two"]),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("PGRST102");
    });

    test("invalid or missing JSON is PGRST102 'Empty or invalid json'", async () => {
      const malformed = await call("/items", { method: "POST", body: "{" });
      expect(malformed.status).toBe(400);
      expect((await json(malformed)).message).toBe("Empty or invalid json");

      const empty = await call("/items", { method: "POST" });
      expect(empty.status).toBe(400);
      expect((await json(empty)).message).toBe("Empty or invalid json");
    });

    test("empty objects insert rows with all-default columns", async () => {
      const one = await call("/items", {
        method: "POST",
        body: "{}",
        headers: { prefer: "return=representation" },
      });
      expect(one.status).toBe(201);
      const [row] = await json(one);
      expect(row.name).toBe("default");

      const two = await call("/items", { method: "POST", body: "[{}, {}]" });
      expect(two.status).toBe(201);
    });

    test("a table without a PK inserts with 201 but no Location", async () => {
      const minimal = await call("/no_pk", {
        method: "POST",
        body: JSON.stringify({ a: "foo", b: "bar" }),
      });
      expect(minimal.status).toBe(201);
      expect(minimal.headers.get("location")).toBeNull();

      const represented = await call("/no_pk", {
        method: "POST",
        body: JSON.stringify({ a: "bar", b: "baz" }),
        headers: { prefer: "return=representation" },
      });
      expect(represented.status).toBe(201);
      expect(await json(represented)).toEqual([{ a: "bar", b: "baz" }]);
      expect(represented.headers.get("location")).toBeNull();
    });

    test("headers-only POST returns a Location built from the generated PK", async () => {
      const res = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "loc" }),
        headers: { prefer: "return=headers-only" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("location")).toMatch(/^\/rest\/items\?id=eq\.\d+$/);
      expect(await res.text()).toBe("");
    });

    test("bulk headers-only POST has no Location", async () => {
      const res = await call("/items", {
        method: "POST",
        body: JSON.stringify([{ name: "b1" }, { name: "b2" }]),
        headers: { prefer: "return=headers-only" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("location")).toBeNull();
    });

    test("compound PK builds both Location parameters", async () => {
      const res = await call("/compound", {
        method: "POST",
        body: JSON.stringify({ a: 7, b: 8, value: "c" }),
        headers: { prefer: "return=headers-only" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("location")).toBe("/rest/compound?a=eq.7&b=eq.8");
    });

    test("blank ?columns is PGRST100", async () => {
      const res = await call("/items?columns=", { method: "POST", body: "[{}]" });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("PGRST100");
    });

    test("unknown ?columns is PGRST204", async () => {
      const res = await call("/items?columns=helicopter", {
        method: "POST",
        body: JSON.stringify([{ name: "x" }]),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe("PGRST204");
      expect(body.message).toBe("Could not find the 'helicopter' column of 'items' in the schema cache");
    });

    test("?columns filters keys and allows non-uniform arrays", async () => {
      const res = await call("/items?columns=name", {
        method: "POST",
        body: JSON.stringify([{ name: "c1", junk: 1 }, { name: "c2", other: 2 }]),
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(201);
      const rows = (await json(res)) as any[];
      expect(rows.map((row) => row.name).sort()).toEqual(["c1", "c2"]);
    });

    test("unicode values round-trip and the Location is usable", async () => {
      const created = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "héllo 💥" }),
        headers: { prefer: "return=headers-only" },
      });
      expect(created.status).toBe(201);
      const location = created.headers.get("location")!;
      expect(location).not.toBeNull();

      const url = new URL(location, "http://localhost");
      const res = await call(`${url.pathname.replace(/^\/rest/, "")}${url.search}`);
      expect(res.status).toBe(200);
      expect((await json(res))[0].name).toBe("héllo 💥");
    });

    test("duplicate primary keys are 409", async () => {
      const res = await call("/compound", {
        method: "POST",
        body: JSON.stringify({ a: 1, b: 1, value: "dup" }),
      });
      expect(res.status).toBe(409);
    });
  });

  // -- UpdateSpec -----------------------------------------------------------

  describe("update (UpdateSpec)", () => {
    test("empty bodies are no-op patches with 204 and */*", async () => {
      for (const body of ["{}", "[]", "[{}]"]) {
        const res = await call("/items?id=eq.1", { method: "PATCH", body });
        expect(res.status).toBe(204);
        expect(res.headers.get("content-range")).toBe("*/*");
        expect(await res.text()).toBe("");
      }
    });

    test("empty body with representation returns 200 and []", async () => {
      const res = await call("/items?id=eq.1", {
        method: "PATCH",
        body: "{}",
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
      expect(res.headers.get("content-range")).toBe("*/*");
    });

    test("zero matched rows with representation returns 200 and []", async () => {
      const res = await call("/items?id=eq.99999", {
        method: "PATCH",
        body: JSON.stringify({ name: "nope" }),
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
    });

    test("a single-element array body is accepted", async () => {
      const res = await call("/items?id=eq.1", {
        method: "PATCH",
        body: JSON.stringify([{ name: "array-one" }]),
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([{ id: 1, name: "array-one" }]);
    });

    test("singular PATCH matching multiple rows is 406 and rolls back", async () => {
      const created = await call("/items", {
        method: "POST",
        body: JSON.stringify([{ name: "sing-a" }, { name: "sing-b" }]),
        headers: { prefer: "return=representation" },
      });
      expect(created.status).toBe(201);

      const patch = await call("/items?name=in.(sing-a,sing-b)", {
        method: "PATCH",
        body: JSON.stringify({ name: "zzz" }),
        headers: { accept: "application/vnd.pgrst.object+json" },
      });
      expect(patch.status).toBe(406);
      expect((await json(patch)).code).toBe("PGRST116");

      const remaining = await call("/items?select=name&name=in.(sing-a,sing-b)&order=name.asc");
      expect((await json(remaining)).map((row: any) => row.name)).toEqual(["sing-a", "sing-b"]);
    });

    test("singular PATCH matching zero rows is 406", async () => {
      const res = await call("/items?id=eq.99999", {
        method: "PATCH",
        body: JSON.stringify({ name: "x" }),
        headers: { accept: "application/vnd.pgrst.object+json" },
      });
      expect(res.status).toBe(406);
      expect((await json(res)).code).toBe("PGRST116");
    });

    test("unknown ?columns on PATCH is PGRST204", async () => {
      const res = await call("/items?id=eq.1&columns=nope", {
        method: "PATCH",
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("PGRST204");
    });

    test("embedded representation works without selecting the parent PK", async () => {
      const author = await call("/authors", {
        method: "POST",
        body: JSON.stringify({ name: "Embed Parent" }),
        headers: { prefer: "return=representation" },
      });
      const [created] = await json(author);
      await call("/books", {
        method: "POST",
        body: JSON.stringify({ author_id: created.id, title: "b1" }),
      });

      const res = await call(`/authors?id=eq.${created.id}&select=name,books(title)`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Embed Parent 2" }),
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([{ name: "Embed Parent 2", books: [{ title: "b1" }] }]);
    });
  });

  // -- UpsertSpec -----------------------------------------------------------

  describe("upsert (UpsertSpec)", () => {
    test("PUT rejects limit/offset with PGRST114", async () => {
      for (const query of ["limit=1", "offset=1"]) {
        const res = await call(`/tiobe?name=eq.Java&${query}`, {
          method: "PUT",
          body: JSON.stringify({ name: "Java", rank: 1 }),
        });
        expect(res.status).toBe(400);
        const body = await json(res);
        expect(body.code).toBe("PGRST114");
        expect(body.message).toBe("limit/offset querystring parameters are not allowed for PUT");
      }
    });

    test("PUT requires all and only PK columns as eq filters (PGRST105)", async () => {
      const cases = [
        { path: "/tiobe?rank=eq.1", body: { name: "Go", rank: 1 } },
        { path: "/tiobe?name=not.eq.Java", body: { name: "Go", rank: 1 } },
        { path: "/compound?a=eq.1", body: { a: 1, b: 2, value: "x" } },
        { path: "/no_pk?a=eq.x&b=eq.y", body: { a: "x", b: "y" } },
      ];
      for (const entry of cases) {
        const res = await call(entry.path, { method: "PUT", body: JSON.stringify(entry.body) });
        expect(res.status).toBe(405);
        const body = await json(res);
        expect(body.code).toBe("PGRST105");
        expect(body.message).toBe("Filters must include all and only primary key columns with 'eq' operators");
      }
    });

    test("PUT rejects a payload primary key that differs from the URL (PGRST115)", async () => {
      const res = await call("/tiobe?name=eq.Java", {
        method: "PUT",
        body: JSON.stringify({ name: "C", rank: 3 }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe("PGRST115");
      expect(body.message).toBe("Payload values do not match URL in primary key column(s)");
    });

    test("PUT uses only the first element of an array payload", async () => {
      const res = await call("/tiobe?name=eq.Java", {
        method: "PUT",
        body: JSON.stringify([{ name: "Java", rank: 19 }, { name: "Swift", rank: 12 }]),
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([{ name: "Java", rank: 19 }]);
    });

    test("PUT insert is 201, update is 200 and minimal is 204", async () => {
      const insert = await call("/compound?a=eq.9&b=eq.9", {
        method: "PUT",
        body: JSON.stringify({ value: "nine" }),
        headers: { prefer: "return=representation" },
      });
      expect(insert.status).toBe(201);
      expect(await json(insert)).toEqual([{ a: 9, b: 9, value: "nine" }]);

      const update = await call("/compound?a=eq.9&b=eq.9", {
        method: "PUT",
        body: JSON.stringify({ value: "nine2" }),
        headers: { prefer: "return=representation" },
      });
      expect(update.status).toBe(200);
      expect(await json(update)).toEqual([{ a: 9, b: 9, value: "nine2" }]);

      const minimal = await call("/compound?a=eq.10&b=eq.10", {
        method: "PUT",
        body: JSON.stringify({ value: "ten" }),
      });
      expect(minimal.status).toBe(204);
      expect(minimal.headers.get("content-range")).toBeNull();
    });

    test("POST merge-duplicates inserts and updates rows", async () => {
      const res = await call("/tiobe", {
        method: "POST",
        body: JSON.stringify([{ name: "Java", rank: 5 }, { name: "Rust", rank: 3 }]),
        headers: { prefer: "return=representation, resolution=merge-duplicates" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("preference-applied")).toBe(
        "resolution=merge-duplicates, return=representation",
      );
      const rows = (await json(res)) as any[];
      expect([...rows].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "Java", rank: 5 },
        { name: "Rust", rank: 3 },
      ]);
    });

    test("POST ignore-duplicates skips conflicting rows", async () => {
      const res = await call("/tiobe", {
        method: "POST",
        body: JSON.stringify([{ name: "Java", rank: 99 }, { name: "Zig", rank: 4 }]),
        headers: { prefer: "return=representation, resolution=ignore-duplicates" },
      });
      expect(res.status).toBe(201);
      expect(await json(res)).toEqual([{ name: "Zig", rank: 4 }]);

      const java = await call("/tiobe?name=eq.Java");
      expect(await json(java)).toEqual([{ name: "Java", rank: 5 }]);
    });

    test("resolution is ignored on a table without a conflict target", async () => {
      const res = await call("/no_pk", {
        method: "POST",
        body: JSON.stringify({ a: "res1", b: "res2" }),
        headers: { prefer: "return=representation, resolution=merge-duplicates" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("preference-applied")).toBe("return=representation");
    });

    test("empty payload with merge-duplicates is 200", async () => {
      const res = await call("/tiobe", {
        method: "POST",
        body: "[]",
        headers: { prefer: "return=representation, resolution=merge-duplicates" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
    });
  });

  // -- DeleteSpec -----------------------------------------------------------

  describe("delete (DeleteSpec)", () => {
    test("zero matched rows with representation returns 200 and []", async () => {
      const res = await call("/items?id=eq.99999", {
        method: "DELETE",
        headers: { prefer: "return=representation" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
    });

    test("singular DELETE of multiple rows is 406 and rolls back", async () => {
      await call("/items", {
        method: "POST",
        body: JSON.stringify([{ name: "del-a" }, { name: "del-b" }]),
      });

      const res = await call("/items?name=in.(del-a,del-b)", {
        method: "DELETE",
        headers: { accept: "application/vnd.pgrst.object+json" },
      });
      expect(res.status).toBe(406);
      expect((await json(res)).code).toBe("PGRST116");

      const remaining = await call("/items?select=name&name=in.(del-a,del-b)");
      expect(await json(remaining)).toHaveLength(2);
    });

    test("singular DELETE of one row returns the object", async () => {
      const created = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "del-one" }),
        headers: { prefer: "return=representation" },
      });
      const [row] = await json(created);

      const res = await call(`/items?id=eq.${row.id}`, {
        method: "DELETE",
        headers: { prefer: "return=representation", accept: "application/vnd.pgrst.object+json" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ id: row.id, name: "del-one" });
    });

    test("DELETE minimal is 204", async () => {
      const created = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "del-min" }),
        headers: { prefer: "return=representation" },
      });
      const [row] = await json(created);
      const res = await call(`/items?id=eq.${row.id}`, { method: "DELETE" });
      expect(res.status).toBe(204);
    });
  });

  // -- HandlingSpec / MaxAffectedSpec ---------------------------------------

  describe("preferences (HandlingSpec, MaxAffectedSpec)", () => {
    test("handling=strict rejects unknown preferences with PGRST122", async () => {
      const read = await call("/items?select=id", { headers: { prefer: "handling=strict, anything" } });
      expect(read.status).toBe(400);
      const body = await json(read);
      expect(body.code).toBe("PGRST122");
      expect(body.message).toBe("Invalid preferences given with handling=strict");
      expect(body.details).toBe("Invalid preferences: anything");

      const write = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "strict-reject" }),
        headers: { prefer: "return=representation, handling=strict, anything" },
      });
      expect(write.status).toBe(400);
      expect((await json(write)).code).toBe("PGRST122");

      const rows = await call("/items?select=id&name=eq.strict-reject");
      expect(await json(rows)).toEqual([]);
    });

    test("handling=lenient ignores unknown preferences", async () => {
      const res = await call("/items?select=id", { headers: { prefer: "handling=lenient, anything" } });
      expect(res.status).toBe(200);
    });

    test("Preference-Applied is absent when no preference was requested", async () => {
      const res = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "no-pref" }),
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("preference-applied")).toBeNull();
    });

    test("max-affected strict blocks an oversized delete and rolls back", async () => {
      const res = await call("/ma_items?id=lt.3", {
        method: "DELETE",
        headers: { prefer: "handling=strict, max-affected=1" },
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe("PGRST124");
      expect(body.message).toBe("Query result exceeds max-affected preference constraint");
      expect(body.details).toBe("The query affects 2 rows");

      const rows = await client.query("select count(*)::int as n from parity.ma_items");
      expect(rows.rows[0].n).toBe(3);
    });

    test("max-affected lenient ignores the limit and is not echoed", async () => {
      const res = await call("/ma_items?id=lt.3", {
        method: "DELETE",
        headers: { prefer: "handling=lenient, max-affected=1" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("preference-applied")).toBe("handling=lenient");
    });

    test("max-affected within the limit echoes handling and max-affected", async () => {
      const res = await call("/ma_items?id=eq.3", {
        method: "PATCH",
        body: JSON.stringify({ name: "ok" }),
        headers: { prefer: "handling=strict, max-affected=5" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("preference-applied")).toBe("handling=strict, max-affected=5");
    });

    test("RPC max-affected enforces strict and echoes both preferences", async () => {
      const over = await call("/rpc/many_items", {
        method: "POST",
        body: JSON.stringify({ n: 10 }),
        headers: { prefer: "handling=strict, max-affected=2" },
      });
      expect(over.status).toBe(400);
      const body = await json(over);
      expect(body.code).toBe("PGRST124");
      expect(body.details).toBe("The query affects 5 rows");

      const lenient = await call("/rpc/many_items", {
        method: "POST",
        body: JSON.stringify({ n: 10 }),
        headers: { prefer: "handling=lenient, max-affected=2" },
      });
      expect(lenient.status).toBe(200);

      const ok = await call("/rpc/many_items", {
        method: "POST",
        body: JSON.stringify({ n: 10 }),
        headers: { prefer: "handling=strict, max-affected=5" },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("preference-applied")).toBe("handling=strict, max-affected=5");
    });

    test("RPC max-affected with strict requires a set-returning function", async () => {
      const res = await call("/rpc/scalar_answer", {
        method: "POST",
        body: "{}",
        headers: { prefer: "handling=strict, max-affected=1" },
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe("PGRST128");
      expect(body.message).toBe(
        "Function must return SETOF or TABLE when max-affected preference is used with handling=strict",
      );
    });
  });

  // -- RangeSpec ------------------------------------------------------------

  describe("range and pagination (RangeSpec)", () => {
    test("limit=0 returns an empty array with */*", async () => {
      const res = await call("/range_items?select=id&order=id&limit=0");
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
      expect(res.headers.get("content-range")).toBe("*/*");
    });

    test("negative limit is 416 PGRST103", async () => {
      const res = await call("/range_items?select=id&limit=-1");
      expect(res.status).toBe(416);
      const body = await json(res);
      expect(body.code).toBe("PGRST103");
      expect(body.message).toBe("Requested range not satisfiable");
      expect(body.details).toBe("Limit should be greater than or equal to zero.");
    });

    test("negative offset is a no-op", async () => {
      const res = await call("/range_items?select=id&order=id&offset=-4");
      expect((await json(res)).map((row: any) => row.id)).toEqual([1, 2, 3, 4, 5]);
      expect(res.headers.get("content-range")).toBe("0-4/*");
    });

    test("Range header overrides the limit query parameter", async () => {
      const res = await call("/range_items?select=id&order=id&limit=2", {
        headers: { range: "0-0" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([{ id: 1 }]);
      expect(res.headers.get("content-range")).toBe("0-0/*");
    });

    test("count=exact reports the real total", async () => {
      const res = await call("/range_items?select=id&order=id", {
        headers: { prefer: "count=exact" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe("0-4/5");
      expect(res.headers.get("preference-applied")).toBe("count=exact");
    });

    test("count on an empty result is */0", async () => {
      const res = await call("/range_items?select=id&id=eq.99", {
        headers: { prefer: "count=exact" },
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([]);
      expect(res.headers.get("content-range")).toBe("*/0");
    });

    test("a partial range with count is 206", async () => {
      const res = await call("/range_items?select=id&order=id", {
        headers: { range: "0-1", prefer: "count=exact" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("0-1/5");
    });

    test("a full range with count stays 200", async () => {
      const res = await call("/range_items?select=id&order=id", {
        headers: { range: "0-4", prefer: "count=exact" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBe("0-4/5");
    });

    test("an offset past the last row with count is 416", async () => {
      const res = await call("/range_items?select=id&offset=100", {
        headers: { prefer: "count=exact" },
      });
      expect(res.status).toBe(416);
      const body = await json(res);
      expect(body.code).toBe("PGRST103");
      expect(body.details).toBe("An offset of 100 was requested, but there are only 5 rows.");
      expect(res.headers.get("content-range")).toBe("*/5");
    });

    test("browser Accept headers still produce JSON", async () => {
      const res = await call("/range_items?select=id&limit=1", {
        headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await json(res)).toEqual([{ id: 1 }]);
    });
  });

  // -- OptionsSpec / HttpHeaderSpec -----------------------------------------

  describe("options and headers (OptionsSpec, HttpHeaderSpec)", () => {
    test("OPTIONS lists every method a writable table supports", async () => {
      const res = await call("/items", { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(res.headers.get("allow")).toBe("OPTIONS,GET,HEAD,POST,PUT,PATCH,DELETE");
      expect(res.headers.get("content-length")).toBe("0");
      expect(await res.text()).toBe("");
    });

    test("OPTIONS on a table without a PK omits PUT", async () => {
      const res = await call("/no_pk", { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(res.headers.get("allow")).toBe("OPTIONS,GET,HEAD,POST,PATCH,DELETE");
    });

    test("OPTIONS on a non-updatable view lists reads only", async () => {
      const res = await call("/read_only_view", { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(res.headers.get("allow")).toBe("OPTIONS,GET,HEAD");
    });

    test("OPTIONS on an unknown table is 404", async () => {
      const res = await call("/unknown", { method: "OPTIONS" });
      expect(res.status).toBe(404);
    });

    test("OPTIONS on a volatile function is POST only", async () => {
      const res = await call("/rpc/volatile_fn", { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(res.headers.get("allow")).toBe("OPTIONS,POST");
    });

    test("OPTIONS on a stable function allows reads and POST", async () => {
      const res = await call("/rpc/many_items", { method: "OPTIONS" });
      expect(res.status).toBe(200);
      expect(res.headers.get("allow")).toBe("OPTIONS,GET,HEAD,POST");
    });

    test("default Vary header matches PostgREST", async () => {
      const read = await call("/items?select=id&limit=1");
      expect(read.headers.get("vary")).toBe("Accept, Prefer, Range");

      const error = await call("/unknown");
      expect(error.headers.get("vary")).toBe("Accept, Prefer, Range");

      const options = await call("/items", { method: "OPTIONS" });
      expect(options.headers.get("vary")).toBe("Accept, Prefer, Range");
    });

    test("Content-Location is alphabetized and omits an empty query", async () => {
      const sorted = await call("/no_pk?b=eq.1&a=eq.1");
      expect(sorted.headers.get("content-location")).toBe("/rest/no_pk?a=eq.1&b=eq.1");

      const bare = await call("/range_items");
      expect(bare.headers.get("content-location")).toBe("/rest/range_items");
    });

    test("Content-Profile negotiates the schema for writes and is echoed", async () => {
      const ok = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "profile" }),
        headers: { "content-profile": "parity" },
      });
      expect(ok.status).toBe(201);
      expect(ok.headers.get("content-profile")).toBe("parity");

      const bad = await call("/items", {
        method: "POST",
        body: JSON.stringify({ name: "nope" }),
        headers: { "content-profile": "other" },
      });
      expect(bad.status).toBe(406);
      expect((await json(bad)).code).toBe("PGRST106");

      const read = await call("/items?select=id&limit=1", {
        headers: { "accept-profile": "parity" },
      });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-profile")).toBe("parity");
    });
  });

  // -- Filters --------------------------------------------------------------

  describe("filters (AndOrParamsSpec, QuerySpec)", () => {
    test("like and ilike treat * as a wildcard alias for %", async () => {
      const like = await call("/range_items?select=id&label=like.r*&order=id");
      expect((await json(like)).map((row: any) => row.id)).toEqual([1, 2, 3, 4, 5]);

      const ilike = await call("/range_items?select=id&label=ilike.R1");
      expect(await json(ilike)).toEqual([{ id: 1 }]);
    });

    test("and/or combine with traditional filters", async () => {
      const res = await call("/range_items?select=id&or=(id.eq.1,id.eq.3)&id=lt.5&order=id");
      expect((await json(res)).map((row: any) => row.id)).toEqual([1, 3]);
    });

    test("in accepts a quoted list", async () => {
      const res = await call("/range_items?select=id&id=in.(1,2)&order=id");
      expect((await json(res)).map((row: any) => row.id)).toEqual([1, 2]);
    });
  });

  // -- RollbackSpec ---------------------------------------------------------

  describe("stability (RollbackSpec)", () => {
    test("a failing bulk insert rolls back every row", async () => {
      const res = await call("/bulk_items", {
        method: "POST",
        body: JSON.stringify([{ id: 1, name: "a" }, { id: 1, name: "b" }]),
      });
      expect(res.status).toBe(409);

      const rows = await client.query("select count(*)::int as n from parity.bulk_items");
      expect(rows.rows[0].n).toBe(0);
    });
  });
});
