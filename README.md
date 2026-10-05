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
- **Writes** — `POST` (bulk), `PATCH`, `PUT` upsert, `DELETE`, with `Prefer: return=representation|minimal|headers-only`, `count`, `resolution`, `missing=default` and `handling=strict`.
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
| `maxRows` | `number` | `Infinity` | Hard cap applied to every read. |
| `defaultLimit` | `number` | — | Limit used when the request omits one. |
| `exposed` | `{ tables?: string[]; views?: string[] } \| false` | all | Allow-list of reachable relations. |
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

Better Auth owns authentication; `pgbase` only consumes the session. Wire it up
by passing the request headers to `auth.api.getSession` inside `getSession`:

```ts
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { createPgbase } from "pgbase";

const auth = betterAuth({
  database: { db: kysely, type: "postgres" },
  emailAndPassword: { enabled: true },
});

const pgbase = createPgbase({
  database: kysely,
  schemaName: "public",
  basePath: "/rest",
  anonRole: "anon",
  getSession: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;                        // -> anonRole
    return {
      role: session.user.role ?? "authenticated",     // required: Postgres role
      sub: session.user.id,                           // -> request.jwt.claim.sub
      email: session.user.email,
    };
  },
});

const app = new Hono();
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw)); // auth
app.all("/rest/*", (c) => pgbase.handler(c.req.raw));               // pgbase
```

A runnable version — with RLS policies, sign-up/sign-in, and a demo UI — lives in
[`example/better-auth-hono.ts`](./example/better-auth-hono.ts):

```sh
# 1. create the demo table + roles
psql "$DATABASE_URL" -f example/schema.sql
# 2. create Better Auth's tables
bun run example/better-auth-hono.ts migrate
# 3. serve
bun run example/better-auth-hono.ts
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
```

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

Prefer: return=representation            # 201/200 with the affected rows
Prefer: return=minimal                   # 204, no body (default)
Prefer: return=headers-only              # status + headers only
Prefer: count=exact                      # Content-Range: */N
Prefer: resolution=merge-duplicates      # POST upsert
Prefer: resolution=ignore-duplicates     # POST skip conflicts
Prefer: missing=default                  # omitted columns use DEFAULT, not NULL
Prefer: handling=strict                  # unknown columns are an error (default: drop)

POST /rest/books?columns=title,author_id   # vertical filtering
```

- `POST` replies `201 Created` with a `Location` header pointing at the new row.
- `PUT` replies `201` when it inserted and `200` when it updated.
- `PATCH`/`DELETE` without a filter are rejected on real tables.
- `Prefer: return=representation` re-reads embedded/many-to-many results, or uses a
  single-statement `RETURNING` when no correlated embed is involved.
- Requesting a representation on a `PATCH`/`PUT`/`DELETE` as the `anon` role that
  matched zero rows returns `401`, mirroring PostgREST.

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

Responses always include a PostgREST-style `Content-Range`. A `Range` request returns `206 Partial Content`. Errors use the PostgREST envelope:

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
set (otherwise they are skipped):

```sh
# Start a throwaway Postgres
docker run -d --name pgb-test-db \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pgb \
  -p 55432:5432 postgres:16-alpine

# Unit tests only (no database)
npm run test:unit

# Full suite, including integration
PGB_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:55432/pgb' npm test

# Or run a single file
PGB_TEST_DATABASE_URL='postgres://postgres:postgres@localhost:55432/pgb' \
  node --test test/rpc.test.ts
```

Each integration suite (`read_schema`, `write_schema`, `api`) provisions its own
Postgres schema, so they can run in the same process without interfering.

The integration suite covers embedding (to-one/to-many/many-to-many), `!inner`, filters, logic, JSON paths, arrays, counts, ranges, CSV, singular objects, `maxRows`, RLS enforcement via role + claims, the full write surface, and RPC (scalar, `SETOF`, `TABLE`, volatile, positional, bulk).

## Hardening

- **`maxRows` also caps RPC** `SETOF` results, and `Prefer: count=exact` on RPC returns a real count.
- **Unfiltered `PATCH`/`DELETE` on base tables is rejected** (views are exempt — they need `INSTEAD OF` triggers to be writable).
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
