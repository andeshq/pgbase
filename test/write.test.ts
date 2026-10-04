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

drop schema if exists write_schema cascade;
create schema write_schema;
grant usage on schema write_schema to anon, authenticated;
set search_path to write_schema;

create table authors (
  id serial primary key,
  name text not null
);
create table books (
  id serial primary key,
  author_id int not null references authors(id),
  title text not null,
  published boolean not null default false,
  meta jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}'
);
create table notes (
  id serial primary key,
  owner text not null,
  body text not null default 'draft'
);
alter table notes enable row level security;
create policy notes_owner on notes for all
  using (owner = current_setting('request.jwt.claim.sub', true))
  with check (owner = current_setting('request.jwt.claim.sub', true));

insert into authors (name) values ('Ada'), ('Bob');
insert into books (author_id, title, published, meta, tags) values
  (1, 'Alpha', true,  '{"isbn":"111"}', '{a,b}'),
  (1, 'Beta',  false, '{"isbn":"222"}', '{b}'),
  (2, 'Gamma', true,  '{"isbn":"333"}', '{c}');

grant select, insert, update, delete on all tables in schema write_schema to anon, authenticated;
grant usage, select on all sequences in schema write_schema to anon, authenticated;
`;

suite("writes against Postgres", () => {
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

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(SETUP_SQL);

    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    pgbase = createPgbase({
      database: db,
      schemaName: "write_schema",
      basePath: "/rest",
      anonRole: "anon",
      getSession: (request: Request) => {
        const sub = request.headers.get("x-sub");
        const role = request.headers.get("x-role") ?? "authenticated";
        if (!sub) return { role };
        return { role, sub };
      },
    } as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  test("POST returns 201 with Location and representation", async () => {
    const res = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "New", published: true, tags: ["x"] }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/rest/books?id=eq.4");
    expect(res.headers.get("preference-applied")).toBe("return=representation");
    const body = (await res.json()) as any[];
    expect(body[0]).toMatchObject({ id: 4, title: "New", published: true });
  });

  test("POST default is minimal 204", async () => {
    const res = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 2, title: "Silent" }),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("bulk POST with representation", async () => {
    const res = await call("/books", {
      method: "POST",
      body: JSON.stringify([
        { author_id: 1, title: "Bulk1" },
        { author_id: 1, title: "Bulk2" },
      ]),
      headers: { prefer: "return=representation" },
    });
    const body = (await res.json()) as any[];
    expect(body.map((b) => b.title)).toEqual(["Bulk1", "Bulk2"]);
  });

  test("PATCH with filters and representation", async () => {
    const res = await call("/books?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ published: false }),
      headers: { prefer: "return=representation, count=exact" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBe("*/1");
    const body = (await res.json()) as any[];
    expect(body[0].published).toBe(false);
  });

  test("PATCH rejects an unfiltered update on a table", async () => {
    const res = await call("/books", {
      method: "PATCH",
      body: JSON.stringify({ published: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("PGRST100");
  });

  test("PUT upsert inserts then updates", async () => {
    const insert = await call("/books?id=eq.100", {
      method: "PUT",
      body: JSON.stringify({ author_id: 1, title: "Upserted" }),
      headers: { prefer: "return=representation" },
    });
    expect(insert.status).toBe(201);
    expect(((await insert.json()) as any[])[0]).toMatchObject({ id: 100, title: "Upserted" });

    const update = await call("/books?id=eq.100", {
      method: "PUT",
      body: JSON.stringify({ author_id: 1, title: "Upserted2" }),
      headers: { prefer: "return=representation" },
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as any[])[0]).toMatchObject({ id: 100, title: "Upserted2" });
  });

  test("DELETE with select representation", async () => {
    const res = await call("/books?id=eq.100", {
      method: "DELETE",
      headers: { prefer: "return=representation", accept: "application/json" },
    });
    // No `select` requested via query string -> PostgREST returns the deleted row.
    const body = (await res.json()) as any[];
    expect(body[0].title).toBe("Upserted2");
  });

  test("DELETE minimal", async () => {
    const create = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 2, title: "ToDelete" }),
      headers: { prefer: "return=representation" },
    });
    const id = ((await create.json()) as any[])[0].id;
    const res = await call(`/books?id=eq.${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("POST with embedded representation in one statement", async () => {
    const res = await call("/authors?select=id,name,books(title)", {
      method: "POST",
      body: JSON.stringify({ name: "Emb" }),
      headers: { prefer: "return=representation" },
    });
    const body = (await res.json()) as any[];
    expect(body[0].name).toBe("Emb");
    expect(body[0].books).toEqual([]);
  });

  test("unknown columns are dropped, strict handling throws", async () => {
    const lenient = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Dropped", nope: 1 }),
      headers: { prefer: "return=representation" },
    });
    expect(lenient.status).toBe(201);

    const strict = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Strict", nope: 1 }),
      headers: { prefer: "return=representation, handling=strict" },
    });
    expect(strict.status).toBe(400);
    expect(((await strict.json()) as any).code).toBe("PGRST204");
  });

  test("columns= restricts writable columns", async () => {
    const res = await call("/books?columns=title", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Cols" }),
      headers: { prefer: "return=representation" },
    });
    // author_id is not in the allow-list, so the NOT NULL column is missing.
    expect(res.status).toBe(400);
  });

  test("Prefer: missing=default inserts defaults", async () => {
    const res = await call("/notes?columns=owner,body", {
      method: "POST",
      body: JSON.stringify({ owner: "u1" }),
      headers: { prefer: "return=representation, missing=default", "x-sub": "u1" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any[])[0].body).toBe("draft");
  });

  test("RLS: writes respect the JWT sub", async () => {
    const mine = await call("/notes", {
      method: "POST",
      body: JSON.stringify({ owner: "u1", body: "mine" }),
      headers: { prefer: "return=representation", "x-sub": "u1" },
    });
    expect(mine.status).toBe(201);

    const theirs = await call("/notes", {
      method: "POST",
      body: JSON.stringify({ owner: "u2", body: "theirs" }),
      headers: { prefer: "return=representation", "x-sub": "u1" },
    });
    // with check (...) rejects writing a row owned by someone else
    expect(theirs.status).toBe(403);

    const visible = await call("/notes?select=body", { headers: { "x-sub": "u1" } });
    expect(((await visible.json()) as any[]).every((n) => n.body !== "theirs")).toBe(true);
  });

  test("unknown RPC function is 404 PGRST202", async () => {
    const res = await call("/rpc/whatever", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("PGRST202");
  });
});
