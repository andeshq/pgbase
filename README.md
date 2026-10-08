# pgbase

A composable, [PostgREST](https://postgrest.org)-compatible API for [Kysely](https://kysely.dev) — built for Node.

Like Better Auth's `auth.handler`, `pgbase` gives you a web-standard `(Request) => Response` handler that you can attach to any router. You bring your own Kysely instance, your own auth, and your own database; `pgbase` turns it into a PostgREST-style REST API with per-request `SET LOCAL ROLE` and claim GUCs so Postgres RLS does the authorization.

```ts
import { createPgbase } from "pgbase";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

const pgbase = createPgbase({
  database,                                         // your Kysely instance
  getSession: (req) => ({ role: "authenticated" }), // -> SET LOCAL ROLE + claim GUCs
});

// The handler is web-standard, so it runs on Node 22.6+ via the built-in
// Request/Response (and on Bun/Deno/Hono/Next unchanged).
```

## Features

- **Composable** — a single `handler(request)` plus a `fetch` alias. Mount it anywhere.
- **Configurable** — pass a Kysely instance, an exposed schema, a session resolver, row caps, an allow-list, hooks.
- **RLS-first** — every request runs in a transaction with `SET LOCAL ROLE`, a schema `search_path`, and the `request.jwt.claims`, `request.headers`, `request.cookies`, `request.method` and `request.path` GUCs.
- **Reads** — `select` (aliases, casts, JSON paths), full operator set, `and`/`or`/`not`, `order`, `limit`/`offset`, `Range`, counts, singular objects, CSV.
- **Writes** — `POST` (bulk), `PATCH`, `PUT` upsert, `DELETE`, with `Prefer: return=representation|minimal|headers-only`, `count`, `resolution`, `missing=default`, `max-affected` and `handling=strict`.
- **Nested writes** — insert and update related to-one, to-many and many-to-many rows in the same request and transaction.
- **RPC** — `POST /rpc/<fn>` for functions and procedures, named or positional args, scalar and `SETOF`/`TABLE` returns, result `select`/filter/`order`/`limit`, and `Prefer: params=bulk`.
- **Embedding** — to-one, to-many and many-to-many, nested, with `!hint` and `!inner`, compiled into a single SQL query with `json_agg` / `to_json`.
- **Schema-aware** — introspects `pg_catalog` once, caches it, and validates tables/columns/relationships.
- **Framework-free** — no runtime framework dependency; only `kysely` as a peer.

## Install

Install straight from GitHub with [Bun](https://bun.sh):

```sh
bun add github:andeshq/pgbase        # latest default branch
bun add github:andeshq/pgbase#v0.1.0 # pinned to a tag
```

pgbase ships its `.ts` sources and Bun strips the types on import — no build step.
`kysely` is a peer dependency; `pg` is only needed for the Postgres driver you
pass to Kysely.

> **Node consumers:** the package is authored for Bun's direct-from-GitHub
> workflow. Node 22.6+ can still run it via `--experimental-strip-types`, but
> the install path above is Bun-only.

## Quick start

```ts
import { Hono } from "hono";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createPgbase } from "pgbase";

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
});

const pgbase = createPgbase({
  database: db,
  schemaName: "public",
  basePath: "/rest",
  maxRows: 1000,
});

const app = new Hono();
app.all("/rest/*", (c) => pgbase.handler(c.req.raw));

export default app;
```

```sh
curl 'http://localhost:3000/rest/books?select=title,author:authors(name)&published=eq.true&order=title.asc&limit=5'
```

Run it with `bun run app.ts` (or `bunx wrangler`/`node` with a Hono adapter).

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `database` | `Kysely<DB>` | — | **Required.** Your Kysely instance. pgbase never opens its own connection. |
| `schemaName` | `string \| string[]` | `"public"` | Exposed Postgres schema (the first entry is used until multi-schema lands). |
| `extraSearchPath` | `string[]` | `["public"]` | Extra schemas on the request `search_path` so extensions resolve. Mirrors `db-extra-search-path`. |
| `basePath` | `string` | `""` | Mount point, e.g. `/rest`. The root route lists exposed relations. |
| `maxRows` | `number` | `1000` | Hard cap applied to reads and set-returning RPCs. Set `Infinity` to disable. |
| `defaultLimit` | `number` | — | Limit used when the request omits one. |
| `exposed` | `{ tables?: string[]; views?: string[] } \| false` | all | Allow-list of reachable relations. |
| `allowUnfilteredViewWrites` | `boolean` | `false` | Permit unfiltered `PATCH`/`DELETE` on updatable views. |
| `anonRole` | `string` | — | Role used when `getSession` returns `null`. Mirrors `db-anon-role`. |
| `allowConnectionRole` | `boolean` | `false` | Acknowledge that role-less requests run as the connection role (silences the startup warning). |
| `maxBodyBytes` | `number` | `1048576` | Reject request bodies larger than this with `413`. |
| `errorVerbosity` | `"verbose" \| "minimal"` | `"verbose"` | `"minimal"` drops `details`/`hint` so row values don't leak. |
| `settings` | `Record<string, string \| number>` | `{}` | Transaction-scoped Postgres settings, e.g. `{ statement_timeout: "5s" }`. |
| `refreshOnNotify` | `boolean` | `false` | Reload the schema cache on `NOTIFY pgrst, 'reload schema'`. |
| `createListenClient` | `() => ListenClient` | — | Dedicated LISTEN connection for `refreshOnNotify`. |
| `notifyChannel` | `string` | `"pgrst"` | Channel used by `refreshOnNotify`. |
| `getSession` | `(req) => PgbaseSession \| null` | — | Resolve the request's identity as a claim object (`role` required). |
| `onRequest` | `(req) => Response \| void` | — | Cheap gate that runs before schema loading. Return a `Response` to short-circuit. |
| `onError` | `(err) => Response \| void` | — | Override error responses. |
| `debug` | `boolean` | `false` | Log requests/errors. |

Hooks receive only the `Request` (and `onError` the thrown error); internal request
context (schema, table, role, claims) stays inside pgbase.

## Attaching to a router

`pgbase.handler` is a plain `(Request) => Promise<Response>`, so it works anywhere.

**Node (`http`)**

`pgbase.handler` is web-standard, so Node just needs a tiny `IncomingMessage` ↔
`Request` adapter (see `example/server.ts`):

```ts
createServer(async (req, res) => {
  const request = await toWebRequest(req);
  await sendWebResponse(res, await pgbase.handler(request));
}).listen(3000);
```

**Bun.serve**

```ts
Bun.serve({ fetch: pgbase.handler });
```

**Hono**

```ts
import { Hono } from "hono";
const app = new Hono();
app.all("/rest/*", (c) => pgbase.handler(c.req.raw));
```

**Elysia**

```ts
new Elysia().all("/rest/*", ({ request }) => pgbase.handler(request));
```

**Next.js (App Router)**

```ts
export const GET = (request: Request) => pgbase.handler(request);
```

## Auth, roles and RLS

pgbase is **auth-mechanism agnostic**. It never verifies tokens or reads cookies —
you resolve the request's identity however you like (sessions, JWT, API keys,
mTLS) and return a claim object from `getSession`. The only required field is
`role`; everything else is context for the database. pgbase then:

1. `SET LOCAL ROLE <claims.role>` (or `anonRole` when `getSession` returns `null`)
2. `set_config('search_path', '<schemaName>, <extraSearchPath>', true)`
3. `set_config('request.jwt.claims', '<json>', true)` — the whole object
4. `set_config('request.jwt.claim.<key>', '<value>', true)` for every key
5. Request context, matching PostgREST:
   - `request.headers` — all headers as JSON, names lowercased
   - `request.cookies` — cookies as JSON
   - `request.method` — e.g. `GET`, `POST`
   - `request.path` — e.g. `books` or `rpc/my_fn`

Because `role` lives *in* the claim object and is also used for `SET LOCAL
ROLE`, this matches PostgREST exactly: the role is a claim, and
`request.jwt.claims->>'role'` works. For unauthenticated requests the claim
object defaults to `{ role: "<anonRole>" }`. The Postgres-side GUC names stay
`request.*` so existing PostgREST RLS policies keep working, even though the JS
contract is mechanism-neutral.

```ts
createPgbase({
  database,
  anonRole: "anon",
  getSession: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;                        // -> anonRole
    return {
      role: session.user.role ?? "authenticated",     // required: Postgres role
      sub: session.user.id,                           // -> request.jwt.claim.sub
      email: session.user.email,                      // -> request.jwt.claim.email
    };
  },
});
```

`getSession` returns `PgbaseSession` (any object with a string `role`) or `null`:

| Return | Result |
| --- | --- |
| `null` | no session → `anonRole` (or the connection's role if unset) |
| `{ role, ...claims }` | `SET LOCAL ROLE` + claim GUCs |
| throw | the error becomes the HTTP response |

Throwing is how you reject invalid/expired credentials with a specific status:
throw a `PgbaseError` (e.g. `new PgbaseError("PGRST301", "Invalid token", 401)`), or
any error carrying a numeric `status`/`statusCode` — pgbase honours it as-is. This
matches how `auth.api.getSession` returns `null` for anonymous but throws for
real failures.

### App roles (`admin`, `staff`, `user`, `anon`)

Map one app role to one Postgres role of the same name — exactly as PostgREST
does:

```sql
create role anon nologin;
create role "user" nologin;
create role staff nologin;
create role admin nologin;

grant "user", staff, admin to authenticator;  -- the role your pool connects as
grant "user" to staff;                         -- staff inherits user's privileges
grant staff to admin;                          -- admin inherits staff's
```

Then `getSession` returns the app role as `role`, and RLS/grants key on those
roles:

```sql
grant select on documents to "user", staff, admin;
grant delete on documents to admin;

create policy staff_docs on documents for select
  using (current_user = 'admin' or author_id = current_setting('request.jwt.claim.sub', true));
```

RLS policies then just work:

```sql
alter table documents enable row level security;

create policy documents_owner on documents
  for select using (owner_id = current_setting('request.jwt.claim.sub', true));
```

Grant the roles the privileges they need (`usage` on the schema, `select` on
tables). Unauthenticated requests use `anonRole`; when `getSession` is absent
entirely, the connection's role is kept.

### Hono + Better Auth

Better Auth owns authentication and role assignment; `pgbase` only consumes the
session. Never pass an application role straight through as a Postgres role:
map it to a fixed set of database roles.

```ts
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { createPgbase } from "pgbase";

const auth = betterAuth({
  database: { db: kysely, type: "postgres" },
  emailAndPassword: { enabled: true },
  plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
});

const pgbase = createPgbase({
  database: kysely,
  schemaName: "public",
  basePath: "/rest",
  anonRole: "anon",
  getSession: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;                        // -> anonRole
    const appRoles = (session.user.role ?? "user").split(",");
    return {
      role: appRoles.includes("admin") ? "app_admin" : "authenticated",
      sub: session.user.id,                           // -> request.jwt.claim.sub
      email: session.user.email,
    };
  },
});

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw)); // auth
app.all("/rest/*", (c) => pgbase.handler(c.req.raw));               // pgbase
```

A runnable API example — with the Better Auth admin plugin, a fixed role mapping,
a least-privilege runtime DB account, and RLS policies — lives in
[`example/better-auth-hono.ts`](./example/better-auth-hono.ts):

```sh
# 1. create roles + app schema using an administrative connection
export ADMIN_DATABASE_URL='postgres://postgres:postgres@localhost:55432/pgb'
psql "$ADMIN_DATABASE_URL" -f example/schema.sql
# 2. create Better Auth tables and grant runtime auth-table access
bun run example/better-auth-hono.ts migrate
# 3. run the API as the restricted authenticator role
export DATABASE_URL='postgres://authenticator:pgbase_dev_only@localhost:55432/pgb'
bun run example/better-auth-hono.ts
```

Exercise the auth and data routes with curl (Better Auth checks the `Origin`):

```sh
curl -i http://localhost:3000/api/auth/sign-up/email \
  -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"name":"Demo","email":"demo@example.com","password":"password123"}'

curl -i -c cookies.txt http://localhost:3000/api/auth/sign-in/email \
  -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}'

curl -b cookies.txt 'http://localhost:3000/rest/todos?select=*'
```

The example exposes only the `app` schema through pgbase; Better Auth tables
remain in `public`. The default signup role is `user`. Promote a user to `admin`
only through a trusted admin operation or a one-time administrative DB update—
never from signup input. For local bootstrap after creating that user:

```sh
psql "$ADMIN_DATABASE_URL" -c \
  "update public.\"user\" set role = 'admin' where email = 'admin@example.com'"
```

## Supported PostgREST syntax

### Select

```
select=*
select=id,name
select=full_name:name
select=id::text
select=profile->>display_name
select=*,books(title,published)
select=author:authors!author_id(name)
select=name,books!inner(title)        # inner embed also filters parents
select=name,books(title,tags(name))   # nested
select=title,...author:authors(name)  # flatten a to-one embed into the row
```

Spread embeds currently support to-one relationships and scalar child columns;
to-many or nested spread requests are rejected rather than silently reshaped.

### Filter operators

| PostgREST | SQL |
| --- | --- |
| `eq` `neq` `gt` `gte` `lt` `lte` | `=` `<>` `>` `>=` `<` `<=` |
| `like` `ilike` `match` `imatch` | `like` `ilike` `~` `~*` |
| `is.null` `is.true` `is.false` | `is null` / `is [not] true` … |
| `not.is.null` | negates any operator (e.g. `deleted_at=not.is.null`) |
| `in.(a,b,c)` | `in (...)` |
| `cs` `cd` `ov` `sl` `sr` `nxr` `nxl` `adj` | `@>` `<@` `&&` `<<` `>>` `&<` `&>` `-\|-` |
| `fts` `plfts` `phfts` `wfts` | `to_tsquery` `plainto_tsquery` `phraseto_tsquery` `websearch_to_tsquery` |
| `not.<op>` | negates any operator |

For `like`/`ilike`, `*` is accepted as an alias for `%` in the pattern, so
`?title=like.*Al*` does not need URL-encoding.

### Logic

```
?or=(age.gt.20,age.lt.10)
?and=(active.is.true,role.eq.admin)
?not.or=(a.eq.1,b.eq.2)
?or=(and(a.eq.1,b.eq.2),c.eq.3)
?age=not.eq.5
```

### Writes

```http
POST   /rest/books                    # single object or array (bulk)
PATCH  /rest/books?id=eq.1            # requires a filter
PUT    /rest/books?id=eq.1            # upsert on the primary key or ?on_conflict=
DELETE /rest/books?id=eq.1            # requires a filter

Prefer: return=representation            # POST 201 / PATCH|PUT|DELETE 200 with rows
Prefer: return=minimal                   # POST 201 / PATCH|PUT|DELETE 204, no body (default)
Prefer: return=headers-only              # same statuses, no body; only POST gets Location
Prefer: count=exact                      # Content-Range total is the affected count
Prefer: resolution=merge-duplicates      # POST upsert (ignored without a PK or ?on_conflict=)
Prefer: resolution=ignore-duplicates     # POST skip conflicts
Prefer: missing=default                  # omitted columns use DEFAULT, not NULL
Prefer: handling=strict                  # unknown columns and preferences are an error
Prefer: max-affected=10                  # PATCH/DELETE/RPC: fail past 10 rows when strict

POST /rest/books?columns=title,author_id   # vertical filtering (validated against the schema)
```

`POST` also accepts nested related objects/arrays. pgbase inserts the related
rows, propagates FK values, and inserts junction rows in the same transaction:

```json
{
  "name": "Ada",
  "books": [{ "title": "A book" }, { "title": "Another book" }]
}
```

The relation keys in the body use table names (not response aliases). Nested
`POST` supports to-one, to-many, and many-to-many relationships and requires a
primary key on the parent.

`PATCH` and `PUT` accept the same nested shapes:

```json
{
  "name": "Ada updated",
  "books": [
    { "id": 7, "title": "Renamed book" },
    { "title": "New book" }
  ]
}
```

Nested update rules:

- An embedded object that includes the related primary key updates that row.
- An embedded object without the primary key inserts a new related row.
- A to-one key can be `null` to detach a parent-owned foreign key.
- Many-to-many elements update the related row and ensure the junction row exists.
- Rows omitted from the payload are left untouched; nested writes never delete.
- A key that does not belong to the parent (or does not exist) is rejected and
  the whole request rolls back.

Nested writes reject `columns`, conflict resolution, and `missing=default`, and
`on_conflict` is only allowed for nested `PUT`. Everything runs in the request
transaction, so a failure at any depth rolls back the whole request.

- `POST` replies `201 Created` (or `200` when `resolution=merge-duplicates` inserted nothing). `Location` is only sent with `Prefer: return=headers-only`.
- `PUT` replies `201` when it inserted and `200` when it updated with `return=representation`; otherwise `204`.
- `PATCH`/`DELETE` reply `200` with `return=representation`, otherwise `204`.
- `Content-Range` follows PostgREST: `*/*` for POST/DELETE, `0-N/*` for PATCH, and none for PUT; the total is the affected count when `Prefer: count` is requested.
- `PUT` requires the query filters to be **exactly the primary-key columns with `eq`** (`405 PGRST105` otherwise), rejects `limit`/`offset` (`400 PGRST114`), and rejects a payload whose primary key disagrees with the URL (`400 PGRST115`).
- `POST []` inserts nothing but is still `201` (`200` for `merge-duplicates`); bulk arrays must have uniform keys unless `?columns=` is given.
- A singular `Accept` on a write enforces exactly one affected row and rolls the write back with `406 PGRST116` otherwise, whatever the return preference.
- `Preference-Applied` only echoes preferences that were explicitly requested, and only when they applied (for example, `resolution` is dropped on a table without a conflict target).
- `max-affected` is enforced for `PATCH`/`DELETE`/RPC when `handling=strict`; RPC additionally requires a `SETOF`/`TABLE` return (`400 PGRST128`).
- Unfiltered `PATCH`/`DELETE` are rejected by default for tables and views;
  explicitly set `allowUnfilteredViewWrites: true` only when a view is safe to sweep.
- `Prefer: return=representation` re-reads embedded/many-to-many results, or uses a
  single-statement `RETURNING` when no correlated embed is involved.
- Requesting a representation on a `PATCH`/`PUT`/`DELETE` as the `anon` role that
  matched zero rows returns `401`, mirroring PostgREST.

### Views

Views and materialized views support reads and appear in the root relation list.
PostgreSQL updatable views support writes according to their view rules and
privileges; non-updatable views and materialized views are rejected with `405`.
Simple direct-column view projections (including chains and joins with projected
FK columns) can inherit relationships for embedding. `UNION` views and complex
expressions are deliberately not guessed. PK-less views can return ordinary
write representations, but embedded write representations require a primary key.

### RPC

Stored functions live under `/rpc/<fn>`. Arguments can come from the JSON body
(named), from the query string, or positionally from extra path segments.

```http
POST /rest/rpc/add              {"a": 2, "b": 3}   # -> [5]
POST /rest/rpc/add?a=2&b=3                           # query-string args
GET  /rest/rpc/add/7/8                               # positional args
GET  /rest/rpc/search_books?term=a&select=title&order=title.asc
POST /rest/rpc/search_books?select=title&published=eq.true   {"term": "a"}
Prefer: params=bulk                [{"a":1},{"a":2}]   # -> [2,3]
```

- **Scalar** returns (`int`, `text`, `json`, ...) come back as a JSON array with
  the single value, e.g. `[5]`.
- **`SETOF`/`TABLE`** returns behave like a table: `select`, filters, `order`,
  `limit`/`offset` and `Prefer: count=exact` all apply over the function result.
- `GET` is allowed only for **read-only** functions (`immutable`/`stable`);
  `volatile` functions require `POST` and otherwise return `405`.
- A query-string key is treated as a **function argument** when it matches a
  declared parameter name; any other key is a **result filter**.
- Calling a function with missing required arguments, or an unknown function,
  returns `404` with code `PGRST202`.

### Ordering, pagination, counts, formats

```
?order=title.asc.nullslast,name.desc
?limit=10&offset=20
?select=*,books(title)&books.order=title.desc&books.limit=3   # order/limit inside an embed
Range: 0-9
Prefer: count=exact
Accept: application/vnd.pgrst.object+json   # single object, 406 if not exactly one
Accept: text/csv
```

> Ordering a parent row by an embedded column (`order=books.title.asc`) is not supported yet; order embedded rows with `books.order=` instead.

Responses always include a PostgREST-style `Content-Range` and a `Content-Location` built from the alphabetized query string. A `Range` header intersects `limit`/`offset` (and is ignored for writes). With `Prefer: count`, a partial range is `206 Partial Content`, a full range stays `200`, and an offset past the last row is `416`. Without a count, reads are `200`. A negative `limit` is `416 PGRST103`; a negative offset is a no-op. `OPTIONS` answers `200` with an `Allow` header listing the methods the relation (or function) supports, and every response carries `Vary: Accept, Prefer, Range`. Writes negotiate the exposed schema with `Content-Profile` (reads use `Accept-Profile`) and echo it back when set. Errors use the PostgREST envelope:

```json
{ "code": "PGRST205", "details": null, "hint": null, "message": "Could not find the table 'nope' in the schema cache" }
```

Postgres errors are mapped to HTTP the way PostgREST does it. Notably, `42501`
(insufficient privilege) is **403 when the request is authenticated and 401
otherwise**, and the `0L*`/`0P*`/`28*` classes map to 403. The SQLSTATE is read
from whichever field the driver uses — `code` for `pg`/`postgres.js`, `errno` for
Bun SQL — so a denied write surfaces as 401/403 rather than a generic 500.

## Testing

Tests run on the Node built-in test runner (`node:test`) with native TypeScript
stripping. Unit tests for the parsers and SQL compilation need no database.
Integration tests run against a real Postgres when `PGB_TEST_DATABASE_URL` is
set (otherwise they are skipped). `test/postgrest-parity.test.ts` borrows
behaviors from PostgREST's own spec suite (insert/update/upsert/delete, range,
preferences, rollback) to lock in API compatibility:

```sh
# Start a throwaway Postgres
docker run -d --name pgb-test-db \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pgb \
  -p 55432:5432 postgres:16-alpine

# Unit tests only (no database)
npm run test:unit

# Full suite, including integration
PGB_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:55432/pgb' npm test

# Bun SQL + kysely-postgres-js driver regression (run with Bun)
PGB_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:55432/pgb' npm run test:bun-sql

# Or run a single file
PGB_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:55432/pgb' \
  node --test test/rpc.test.ts
```

`npm test` runs test files sequentially because Postgres roles are cluster-wide.
Each integration suite (`read_schema`, `write_schema`, `api`) provisions its own
Postgres schema, so they can run in the same process without interfering.

The integration suite covers embedding (to-one/to-many/many-to-many), `!inner`, filters, logic, JSON paths, arrays, counts, ranges, CSV, singular objects, `maxRows`, RLS enforcement via role + claims, the full write surface, and RPC (scalar, `SETOF`, `TABLE`, volatile, positional, bulk).

## Hardening

- **`maxRows` also caps RPC** `SETOF` results, and `Prefer: count=exact` on RPC returns a real count.
- **Unfiltered `PATCH`/`DELETE` is rejected** by default, including on views. Updatable views can opt in with `allowUnfilteredViewWrites: true`.
- **Request bodies are size-limited** (`maxBodyBytes`, default 1 MiB) and rejected with `413` before being processed, whether or not `Content-Length` is present.
- **`errorVerbosity: "minimal"`** suppresses Postgres `details`/`hint`, which can contain row values.
- **`settings`** applies transaction-scoped Postgres settings (e.g. `statement_timeout`) to every request.
- **Schema cache reload** on `NOTIFY pgrst, 'reload schema'` when `refreshOnNotify` and a `createListenClient` are provided:

  ```ts
  const pgbase = createPgbase({
    database,
    refreshOnNotify: true,
    createListenClient: async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      return client;
    },
  });
  const listener = await pgbase.listen();
  // ...later: await listener.stop();
  ```

- **No-role safety net**: if neither `getSession` nor `anonRole` is configured, pgbase warns that requests run with the connection's role. Set `allowConnectionRole: true` to acknowledge.

## Not yet implemented

- `Accept-Profile` / `Content-Profile` multi-schema routing (the header is validated today, single schema exposed).
- Aggregates in `select` (`sum`, `count`, ...).
- OpenAPI document at the service root.
- Function overloading by argument type (`/rpc/fn` resolves by name only, so
  same-name overloads are not disambiguated).
- Nested writes never delete omitted related rows.
