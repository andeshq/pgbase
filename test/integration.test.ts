import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { expect } from "./expect.ts";
import { Client, Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createPgbase, PgbaseError } from "../src/index.ts";

const DATABASE_URL = process.env.PGB_TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

const SETUP_SQL = `
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

drop schema if exists read_schema cascade;
create schema read_schema;
grant usage on schema read_schema to anon, authenticated;
set search_path to read_schema;

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
create table tags (
  id serial primary key,
  name text not null
);
create table book_tags (
  book_id int not null references books(id),
  tag_id int not null references tags(id),
  primary key (book_id, tag_id)
);
create table secrets (
  id serial primary key,
  owner text not null,
  value text not null
);
alter table secrets enable row level security;
create policy secrets_owner_select on secrets for select
  using (owner = current_setting('request.jwt.claim.sub', true));

-- Echo the request-context GUCs so tests can assert PostgREST parity.
create function request_probe() returns table (
  db_role text, method text, path text,
  header_ua text, cookie_sid text, claims_role text, claims_sub text
)
language sql stable as $$
  select current_user::text,
         current_setting('request.method', true)::text,
         current_setting('request.path', true)::text,
         current_setting('request.headers', true)::json->>'user-agent',
         current_setting('request.cookies', true)::json->>'sid',
         current_setting('request.jwt.claims', true)::json->>'role',
         current_setting('request.jwt.claims', true)::json->>'sub'
$$;
grant execute on function request_probe() to anon, authenticated;

insert into authors (name) values ('Ada'), ('Bob'), ('Cleo');
insert into books (author_id, title, published, meta, tags) values
  (1, 'Alpha', true,  '{"isbn":"111"}', '{a,b}'),
  (1, 'Beta',  false, '{"isbn":"222"}', '{b}'),
  (2, 'Gamma', true,  '{"isbn":"333"}', '{c}'),
  (3, 'Delta', true,  '{"isbn":"444"}', '{}');
insert into tags (name) values ('a'), ('b'), ('c');
insert into book_tags (book_id, tag_id) values (1,1),(1,2),(2,2),(3,3),(4,3);
insert into secrets (owner, value) values ('u1','s1'),('u1','s2'),('u2','s3');

grant select on all tables in schema read_schema to anon, authenticated;
grant usage, select on all sequences in schema read_schema to anon, authenticated;
`;

suite("integration against Postgres", () => {
  let client: Client;
  let pool: Pool;
  let db: Kysely<any>;
  let pgbase: ReturnType<typeof createPgbase>;
  let capped: ReturnType<typeof createPgbase>;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(SETUP_SQL);

    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });

    const config = {
      database: db,
      schemaName: "read_schema",
      basePath: "/rest/v1",
      anonRole: "anon",
      getSession: (request: Request) => {
        const sub = request.headers.get("x-sub");
        const role = request.headers.get("x-role") ?? "authenticated";
        if (sub === "invalid") {
          throw new PgbaseError("PGRST301", "Invalid token", 401);
        }
        if (!sub) return role === "anon" ? { role } : null;
        return { role, sub };
      },
    } as const;

    pgbase = createPgbase(config as any);
    capped = createPgbase({ ...config, maxRows: 2 } as any);
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  const call = (path: string, init?: RequestInit) =>
    pgbase.handler(new Request(`http://localhost/rest/v1${path}`, init as any));

  test("to-many embedding", async () => {
    const res = await call("/authors?select=name,books(title)&order=name.asc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((a) => a.name)).toEqual(["Ada", "Bob", "Cleo"]);
    expect(body[0].books.map((b: any) => b.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  test("to-one embedding", async () => {
    const res = await call("/books?select=title,author:authors(name)&id=eq.1");
    const body = (await res.json()) as any[];
    expect(body).toEqual([{ title: "Alpha", author: { name: "Ada" } }]);
  });

  test("many-to-many embedding", async () => {
    const res = await call("/books?select=title,tags(name)&id=eq.1");
    const body = (await res.json()) as any[];
    expect(body[0].tags.map((t: any) => t.name).sort()).toEqual(["a", "b"]);
  });

  test("inner embed filters parents", async () => {
    const res = await call("/authors?select=name,books!inner(title)&books.published=eq.false&order=name.asc");
    const body = (await res.json()) as any[];
    expect(body.map((a) => a.name)).toEqual(["Ada"]);
    expect(body[0].books).toEqual([{ title: "Beta" }]);
  });

  test("filters, order and in()", async () => {
    const res = await call("/books?select=title&published=eq.true&order=title.asc");
    expect(((await res.json()) as any[]).map((b: any) => b.title)).toEqual(["Alpha", "Delta", "Gamma"]);

    const inRes = await call("/books?select=title&id=in.(1,3)&order=id.asc");
    expect(((await inRes.json()) as any[]).map((b: any) => b.title)).toEqual(["Alpha", "Gamma"]);
  });

  test("array contains operator", async () => {
    const res = await call("/books?select=title&tags=cs.{b}&order=title.asc");
    expect(((await res.json()) as any[]).map((b: any) => b.title)).toEqual(["Alpha", "Beta"]);
  });

  test("json path filter and projection", async () => {
    const filtered = await call("/books?select=title&meta->>isbn=eq.333");
    expect(((await filtered.json()) as any[]).map((b: any) => b.title)).toEqual(["Gamma"]);

    const projected = await call("/books?select=title,isbn:meta->>isbn&id=eq.1");
    expect(await projected.json()).toEqual([{ title: "Alpha", isbn: "111" }]);
  });

  test("logical or", async () => {
    const res = await call("/books?select=title&or=(title.eq.Alpha,title.eq.Gamma)&order=title.asc");
    expect(((await res.json()) as any[]).map((b: any) => b.title)).toEqual(["Alpha", "Gamma"]);
  });

  test("count via Prefer", async () => {
    const res = await call("/books?select=title&published=eq.true", {
      headers: { prefer: "count=exact" },
    });
    expect(res.headers.get("content-range")).toBe("0-2/3");
    expect(res.headers.get("preference-applied")).toBe("count=exact");
    expect(res.status).toBe(200);
  });

  test("singular object response", async () => {
    const res = await call("/books?select=title&id=eq.1", {
      headers: { accept: "application/vnd.pgrst.object+json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Alpha" });
  });

  test("singular with multiple rows is 406", async () => {
    const res = await call("/books?select=title&id=gt.0", {
      headers: { accept: "application/vnd.pgrst.object+json" },
    });
    expect(res.status).toBe(406);
    expect(((await res.json()) as any).code).toBe("PGRST116");
  });

  test("limit, offset and Range header", async () => {
    const limited = await call("/books?select=id&order=id.asc&limit=2&offset=1");
    expect(((await limited.json()) as any[]).map((b: any) => b.id)).toEqual([2, 3]);
    expect(limited.status).toBe(200);

    const ranged = await call("/books?select=id&order=id.asc", { headers: { range: "1-2" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("1-2/*");
    expect(((await ranged.json()) as any[]).map((b: any) => b.id)).toEqual([2, 3]);

    const counted = await call("/books?select=id&order=id.asc", {
      headers: { range: "1-2", prefer: "count=exact" },
    });
    expect(counted.headers.get("content-range")).toBe("1-2/4");
  });

  test("csv output", async () => {
    const res = await call("/books?select=id,title&order=id.asc&limit=1", {
      headers: { accept: "text/csv" },
    });
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect((await res.text()).trim()).toBe("id,title\r\n1,Alpha");
  });

  test("RLS: claims restrict rows", async () => {
    const mine = await call("/secrets?select=value&order=value.asc", { headers: { "x-sub": "u1" } });
    expect(((await mine.json()) as any[]).map((s: any) => s.value)).toEqual(["s1", "s2"]);

    const anon = await call("/secrets?select=value", {
      headers: { "x-role": "anon" },
    });
    expect(await anon.json()).toEqual([]);
  });

  test("getSession returning null falls back to anonRole", async () => {
    // No x-sub and no x-role -> getSession returns null -> anonRole ("anon").
    const res = await call("/secrets?select=value");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("getSession may throw to produce an error response", async () => {
    const res = await call("/books?select=title", { headers: { "x-sub": "invalid" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.code).toBe("PGRST301");
    expect(body.message).toBe("Invalid token");
  });

  test("request-context GUCs are exposed (headers, cookies, method, path)", async () => {
    const res = await call("/rpc/request_probe", {
      method: "POST",
      body: "{}",
      headers: {
        "x-sub": "u1",
        "user-agent": "pgbase-test/1.0",
        cookie: "sid=abc123; theme=dark",
      },
    });
    expect(res.status).toBe(200);
    const [row] = (await res.json()) as any[];
    expect(row).toMatchObject({
      db_role: "authenticated",
      method: "POST",
      path: "rpc/request_probe",
      header_ua: "pgbase-test/1.0",
      cookie_sid: "abc123",
      claims_role: "authenticated",
      claims_sub: "u1",
    });
  });

  test("anonymous requests still get request context and a role claim", async () => {
    const res = await call("/rpc/request_probe", {
      method: "POST",
      body: "{}",
      headers: { "x-role": "anon" },
    });
    expect(res.status).toBe(200);
    const [row] = (await res.json()) as any[];
    expect(row).toMatchObject({
      db_role: "anon",
      method: "POST",
      claims_role: "anon",
      claims_sub: null,
    });
  });

  test("maxRows caps the result", async () => {
    const res = await capped.handler(new Request("http://localhost/rest/v1/books?select=id&order=id.asc"));
    expect(((await res.json()) as any[]).map((b: any) => b.id)).toEqual([1, 2]);
  });

  test("unknown table and wrong base path", async () => {
    const missing = await call("/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).code).toBe("PGRST205");

    const wrongBase = await pgbase.handler(new Request("http://localhost/wrong/books"));
    expect(wrongBase.status).toBe(404);
  });

  test("root lists exposed relations", async () => {
    const res = await call("");
    const body = (await res.json()) as any;
    expect(body.schema).toBe("read_schema");
    expect(body.tables).toContain("books");
  });

  test("method not allowed for unsupported verbs", async () => {
    const res = await call("/books", { method: "OPTIONS" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });
});
