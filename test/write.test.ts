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

drop schema if exists write_schema cascade;
create schema write_schema;
grant usage on schema write_schema to anon, authenticated;
set search_path to write_schema;

create table authors (
  id serial primary key,
  name text not null
);
create table author_profiles (
  id serial primary key,
  author_id int not null unique references authors(id),
  bio text not null
);
create table books (
  id serial primary key,
  author_id int not null references authors(id),
  title text not null,
  published boolean not null default false,
  meta jsonb not null default '{}'::jsonb,
  labels text[] not null default '{}'
);
create table tags (
  id serial primary key,
  name text not null
);
create table book_tags (
  book_id int not null references books(id),
  tag_id int not null references tags(id),
  primary key (book_id, tag_id)
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
insert into books (author_id, title, published, meta, labels) values
  (1, 'Alpha', true,  '{"isbn":"111"}', '{a,b}'),
  (1, 'Beta',  false, '{"isbn":"222"}', '{b}'),
  (2, 'Gamma', true,  '{"isbn":"333"}', '{c}');

create view authors_view as select id, name from authors;
create view joined_books_view as
  select books.id, books.title, authors.name as author
  from books join authors on authors.id = books.author_id;
create materialized view books_materialized as select id, title from books;

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

  test("POST with representation returns 201 and no Location", async () => {
    const res = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "New", published: true, labels: ["x"] }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(201);
    // PostgREST only builds `Location` for `return=headers-only`.
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("preference-applied")).toBe("return=representation");
    const body = (await res.json()) as any[];
    expect(body[0]).toMatchObject({ id: 4, title: "New", published: true });
  });

  test("POST default is minimal 201 with no body", async () => {
    const res = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 2, title: "Silent" }),
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("");
  });

  test("headers-only writes use PostgREST statuses and only POST gets Location", async () => {
    const created = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Headers" }),
      headers: { prefer: "return=headers-only" },
    });
    expect(created.status).toBe(201);
    const location = created.headers.get("location")!;
    expect(location).not.toBeNull();
    expect(await created.text()).toBe("");
    const id = Number(new URL(`http://localhost${location}`).searchParams.get("id")!.replace("eq.", ""));

    const patched = await call(`/books?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ published: true }),
      headers: { prefer: "return=headers-only" },
    });
    expect(patched.status).toBe(204);

    const put = await call(`/books?id=eq.${id}`, {
      method: "PUT",
      body: JSON.stringify({ id, author_id: 1, title: "Headers PUT" }),
      headers: { prefer: "return=headers-only" },
    });
    expect(put.status).toBe(204);

    const deleted = await call(`/books?id=eq.${id}`, {
      method: "DELETE",
      headers: { prefer: "return=headers-only" },
    });
    expect(deleted.status).toBe(204);
  });

  test("write Content-Range matches PostgREST per method", async () => {
    const post = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Range" }),
    });
    expect(post.headers.get("content-range")).toBe("*/*");

    const postCounted = await call("/books", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Range counted" }),
      headers: { prefer: "count=exact" },
    });
    expect(postCounted.headers.get("content-range")).toBe("*/1");

    const created = await call("/books?select=id", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Range patch" }),
      headers: { prefer: "return=representation" },
    });
    const rangeId = ((await created.json()) as any[])[0].id;

    const patch = await call(`/books?id=eq.${rangeId}`, {
      method: "PATCH",
      body: JSON.stringify({ published: true }),
    });
    expect(patch.headers.get("content-range")).toBe("0-0/*");

    const put = await call(`/books?id=eq.${rangeId}`, {
      method: "PUT",
      body: JSON.stringify({ id: rangeId, author_id: 1, title: "Range PUT" }),
    });
    expect(put.headers.get("content-range")).toBeNull();

    const deleted = await call(`/books?id=eq.${rangeId}`, { method: "DELETE" });
    expect(deleted.headers.get("content-range")).toBe("*/*");
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
    expect(res.headers.get("content-range")).toBe("0-0/1");
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

  test("views support reads and auto-updatable writes", async () => {
    const read = await call("/authors_view?select=id,name&name=eq.Ada");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual([{ id: 1, name: "Ada" }]);

    const create = await call("/authors_view", {
      method: "POST",
      body: JSON.stringify({ name: "View Insert" }),
      headers: { prefer: "return=representation" },
    });
    expect(create.status).toBe(201);
    const createdRows = (await create.json()) as any[];
    expect(createdRows[0].name).toBe("View Insert");

    const headersOnly = await call("/authors_view", {
      method: "POST",
      body: JSON.stringify({ name: "Headers Only" }),
      headers: { prefer: "return=headers-only" },
    });
    expect(headersOnly.status).toBe(201);
    expect(headersOnly.headers.get("location")).toBeNull();
  });

  test("non-updatable views and materialized views reject writes with 405", async () => {
    const joinWrite = await call("/joined_books_view", {
      method: "POST",
      body: JSON.stringify({ title: "Cannot insert" }),
    });
    expect(joinWrite.status).toBe(405);
    expect(joinWrite.headers.get("allow")).toBe("GET, HEAD");

    const matviewWrite = await call("/books_materialized", {
      method: "POST",
      body: JSON.stringify({ title: "Cannot insert" }),
    });
    expect(matviewWrite.status).toBe(405);
  });

  test("PK-less views return a clear error for embedded write representations", async () => {
    const res = await call("/authors_view?select=*,books(title)", {
      method: "POST",
      body: JSON.stringify({ name: "No PK Embed" }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toMatch(/without a primary key/);
  });

  test("nested POST inserts a parent and to-many children atomically", async () => {
    const before = Number((await client.query("select count(*)::int as n from write_schema.authors")).rows[0].n);
    const res = await call("/authors?select=id,name,books(title)", {
      method: "POST",
      body: JSON.stringify({ name: "Nested", books: [{ title: "Nested A" }, { title: "Nested B" }] }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(201);
    const [author] = (await res.json()) as any[];
    expect(author.name).toBe("Nested");
    expect(author.books.map((book: any) => book.title).sort()).toEqual(["Nested A", "Nested B"]);
    expect(Number((await client.query("select count(*)::int as n from write_schema.authors")).rows[0].n)).toBe(before + 1);

    const failed = await call("/authors", {
      method: "POST",
      body: JSON.stringify({ name: "Must Roll Back", books: [{ published: true }] }),
    });
    expect(failed.status).toBe(400);
    expect(Number((await client.query("select count(*)::int as n from write_schema.authors")).rows[0].n)).toBe(before + 1);
  });

  test("nested POST inserts a to-one relation before the parent", async () => {
    const res = await call("/books?select=title,author:authors(name)", {
      method: "POST",
      body: JSON.stringify({ title: "Nested to-one", authors: { name: "Nested Author" } }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual([{ title: "Nested to-one", author: { name: "Nested Author" } }]);
  });

  test("nested POST inserts a reverse one-to-one child after the parent", async () => {
    const res = await call("/authors?select=name,author_profiles(bio)", {
      method: "POST",
      body: JSON.stringify({ name: "Profile Parent", author_profiles: { bio: "Nested bio" } }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual([{ name: "Profile Parent", author_profiles: { bio: "Nested bio" } }]);

    const spread = await call("/authors?select=name,...author_profiles(bio)&name=eq.Profile%20Parent");
    expect(spread.status).toBe(200);
    expect(await spread.json()).toEqual([{ name: "Profile Parent", bio: "Nested bio" }]);
  });

  test("nested POST creates many-to-many junction rows", async () => {
    const res = await call("/books?select=title,tags(name)", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "Nested tags", tags: [{ name: "nested-tag" }] }),
      headers: { prefer: "return=representation" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual([{ title: "Nested tags", tags: [{ name: "nested-tag" }] }]);
  });

  test("nested PATCH updates existing children and inserts new ones", async () => {
    const create = await call("/authors?select=id,name,books(id,title)", {
      method: "POST",
      body: JSON.stringify({ name: "Patch Parent", books: [{ title: "First" }, { title: "Second" }] }),
      headers: { prefer: "return=representation" },
    });
    const [author] = (await create.json()) as any[];
    const [first, second] = author.books;

    const patch = await call(`/authors?id=eq.${author.id}&select=id,name,books(id,title)`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Patch Parent Updated",
        books: [{ id: first.id, title: "First Renamed" }, { title: "Third" }],
      }),
      headers: { prefer: "return=representation" },
    });
    expect(patch.status).toBe(200);
    const [patched] = (await patch.json()) as any[];
    expect(patched.name).toBe("Patch Parent Updated");
    const titles = new Map<number, string>(patched.books.map((book: any) => [book.id, book.title]));
    expect(titles.get(first.id)).toBe("First Renamed");
    expect(titles.get(second.id)).toBe("Second");
    expect([...titles.values()].filter((title) => title === "Third")).toHaveLength(1);
  });

  test("nested PATCH cannot update a child owned by another parent", async () => {
    const createA = await call("/authors?select=id,books(id,title)", {
      method: "POST",
      body: JSON.stringify({ name: "Owner A", books: [{ title: "A book" }] }),
      headers: { prefer: "return=representation" },
    });
    const createB = await call("/authors?select=id,books(id,title)", {
      method: "POST",
      body: JSON.stringify({ name: "Owner B", books: [{ title: "B book" }] }),
      headers: { prefer: "return=representation" },
    });
    const [ownerA] = (await createA.json()) as any[];
    const [ownerB] = (await createB.json()) as any[];

    const hijack = await call(`/authors?id=eq.${ownerA.id}`, {
      method: "PATCH",
      body: JSON.stringify({ books: [{ id: ownerB.books[0].id, title: "Hijacked" }] }),
    });
    expect(hijack.status).toBe(400);

    const bBook = await client.query("select title from write_schema.books where id = $1", [ownerB.books[0].id]);
    expect(bBook.rows[0].title).toBe("B book");
    const aBook = await client.query("select title from write_schema.books where id = $1", [ownerA.books[0].id]);
    expect(aBook.rows[0].title).toBe("A book");
  });

  test("nested PATCH updates a reverse one-to-one child", async () => {
    const create = await call("/authors?select=id,author_profiles(id,bio)", {
      method: "POST",
      body: JSON.stringify({ name: "Profile Patch", author_profiles: { bio: "before" } }),
      headers: { prefer: "return=representation" },
    });
    const [author] = (await create.json()) as any[];

    const patch = await call(`/authors?id=eq.${author.id}&select=id,author_profiles(id,bio)`, {
      method: "PATCH",
      body: JSON.stringify({ author_profiles: { id: author.author_profiles.id, bio: "after" } }),
      headers: { prefer: "return=representation" },
    });
    expect(patch.status).toBe(200);
    const [patched] = (await patch.json()) as any[];
    expect(patched.author_profiles.bio).toBe("after");
  });

  test("nested PATCH updates a parent-owned to-one relation", async () => {
    const book = await call("/books?select=id,authors(id,name)", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "M2O Patch" }),
      headers: { prefer: "return=representation" },
    });
    const [created] = (await book.json()) as any[];
    const target = await call("/authors?select=id,name", {
      method: "POST",
      body: JSON.stringify({ name: "M2O Target" }),
      headers: { prefer: "return=representation" },
    });
    const [targetAuthor] = (await target.json()) as any[];

    const patch = await call(`/books?id=eq.${created.id}&select=id,title,authors(id,name)`, {
      method: "PATCH",
      body: JSON.stringify({ authors: { id: targetAuthor.id, name: "M2O Renamed" } }),
      headers: { prefer: "return=representation" },
    });
    expect(patch.status).toBe(200);
    const [patched] = (await patch.json()) as any[];
    expect(patched.authors).toEqual({ id: targetAuthor.id, name: "M2O Renamed" });
  });

  test("nested PATCH updates and links many-to-many rows", async () => {
    const create = await call("/books?select=id,tags(id,name)", {
      method: "POST",
      body: JSON.stringify({ author_id: 1, title: "M2M Patch", tags: [{ name: "m2m-one" }] }),
      headers: { prefer: "return=representation" },
    });
    const [book] = (await create.json()) as any[];

    const patch = await call(`/books?id=eq.${book.id}&select=id,tags(id,name)`, {
      method: "PATCH",
      body: JSON.stringify({
        tags: [{ id: book.tags[0].id, name: "m2m-one-renamed" }, { name: "m2m-two" }],
      }),
      headers: { prefer: "return=representation" },
    });
    expect(patch.status).toBe(200);
    const [patched] = (await patch.json()) as any[];
    expect(patched.tags.map((tag: any) => tag.name).sort()).toEqual(["m2m-one-renamed", "m2m-two"]);
    const junctions = await client.query("select count(*)::int as n from write_schema.book_tags where book_id = $1", [book.id]);
    expect(junctions.rows[0].n).toBe(2);
  });

  test("nested PUT upserts the parent and its children", async () => {
    const create = await call("/authors?select=id,name,books(id,title)", {
      method: "POST",
      body: JSON.stringify({ name: "Put Parent", books: [{ title: "Put First" }] }),
      headers: { prefer: "return=representation" },
    });
    const [author] = (await create.json()) as any[];

    const put = await call(`/authors?id=eq.${author.id}&select=id,name,books(id,title)`, {
      method: "PUT",
      body: JSON.stringify({
        id: author.id,
        name: "Put Parent Updated",
        books: [{ id: author.books[0].id, title: "Put First Updated" }, { title: "Put Second" }],
      }),
      headers: { prefer: "return=representation" },
    });
    expect(put.status).toBe(200);
    const [patched] = (await put.json()) as any[];
    expect(patched.name).toBe("Put Parent Updated");
    expect(patched.books.map((entry: any) => entry.title).sort()).toEqual(["Put First Updated", "Put Second"]);
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
