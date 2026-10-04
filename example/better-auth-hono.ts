/**
 * Better Auth + Hono + pgbase.
 *
 * One Hono app serves three things:
 *   1. Better Auth's own endpoints   (/api/auth/*)
 *   2. pgbase's PostgREST API        (/rest/*)
 *   3. A tiny demo UI                (/)
 *
 * Better Auth owns authentication (sign-up/sign-in, sessions, cookies). pgbase
 * never verifies tokens itself — it asks Better Auth for the session and turns
 * the result into a Postgres `SET LOCAL ROLE` + claim GUCs, so RLS does the
 * authorization.
 *
 * Dependencies (this example only — not part of the published package):
 *   bun add hono @hono/node-server better-auth kysely pg
 *
 * Setup:
 *   1. Create the demo table + Postgres roles (see `example/schema.sql`).
 *   2. Create Better Auth's tables:   bun run example/better-auth-hono.ts migrate
 *   3. Start the server:              bun run example/better-auth-hono.ts
 *
 * Env:
 *   DATABASE_URL        postgres://postgres:postgres@localhost:55432/pgb
 *   PORT                3000
 *   BETTER_AUTH_SECRET  32+ char secret (generate with `openssl rand -base64 32`)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { createPgbase, PgbaseError } from "../src/index.ts";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/pgb";
const port = Number(process.env.PORT ?? 3000);

// One Kysely instance, shared by Better Auth and pgbase.
const pool = new Pool({ connectionString });
const database = new Kysely({ dialect: new PostgresDialect({ pool }) });

/**
 * Better Auth stores users/sessions in Postgres and manages cookies for us.
 * Swap the auth methods for whatever you use in production.
 */
export const auth = betterAuth({
  // Better Auth wants the Kysely instance wrapped with its dialect type.
  database: { db: database, type: "postgres" },
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-at-least-32-chars",
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      // The app role the user gets. pgbase maps it 1:1 to a Postgres role.
      role: { type: "string", required: false, defaultValue: "authenticated" },
    },
  },
});

/**
 * pgbase is auth-agnostic: it just needs claims. We resolve them here from the
 * Better Auth session. `role` is required (the Postgres role to impersonate);
 * every other key becomes `request.jwt.claim.<key>`.
 *
 *   return null     -> anonymous (anonRole)
 *   return { role } -> SET LOCAL ROLE + claim GUCs
 *   throw           -> error response
 */
export const pgbase = createPgbase({
  database,
  schemaName: "public",
  extraSearchPath: ["public"],
  basePath: "/rest",
  maxRows: 1000,
  anonRole: "anon",

  getSession: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    return {
      role: (session.user as { role?: string }).role ?? "authenticated",
      sub: session.user.id,
      email: session.user.email,
    };
  },

  onError: (error) => {
    if (error instanceof PgbaseError && error.status >= 500) {
      console.error("[pgbase]", error);
    }
  },

  debug: process.env.DEBUG === "1",
});

export const app = new Hono();

// 1. Better Auth's endpoints (sign-up, sign-in, sign-out, session, ...).
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// 2. pgbase's PostgREST API.
app.all("/rest/*", (c) => pgbase.handler(c.req.raw));

// 3. A tiny demo UI so you can drive it from the browser.
app.get("/", (c) =>
  c.html(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>pgbase + Better Auth</title></head>
  <body style="font-family: system-ui; max-width: 40rem; margin: 3rem auto">
    <h1>pgbase + Better Auth</h1>
    <p>Cookie-based session, resolved server-side for pgbase.</p>
    <button onclick="signIn()">Sign in (demo user)</button>
    <button onclick="load()">GET /rest/todos</button>
    <pre id="out"></pre>
    <script>
      const out = (x) => document.getElementById("out").textContent =
        typeof x === "string" ? x : JSON.stringify(x, null, 2);

      async function signIn() {
        const email = "demo@example.com";
        const password = "password123";
        // Sign up (ignore "already exists"), then sign in.
        await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, name: "Demo" }),
        });
        const res = await fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        out(await res.json());
      }

      async function load() {
        const res = await fetch("/rest/todos?select=*");
        out({ status: res.status, body: await res.json() });
      }
    </script>
  </body>
</html>`),
);

/** Create Better Auth's tables (`bun run ... migrate`). */
if (process.argv[2] === "migrate") {
  const ctx = await auth.$context;
  await ctx.runMigrations();
  console.log("[pgbase] Better Auth schema is up to date");
  await database.destroy();
  process.exit(0);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`http://localhost:${info.port}`);
  console.log(`  auth    http://localhost:${info.port}/api/auth/*`);
  console.log(`  pgbase  http://localhost:${info.port}/rest/*`);
});
