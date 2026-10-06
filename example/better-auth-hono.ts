/**
 * Better Auth + Hono + pgbase.
 *
 * One Hono app serves two things:
 *   1. Better Auth's own endpoints   (/api/auth/*)
 *   2. pgbase's PostgREST API        (/rest/*)
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
 *   DATABASE_URL        postgres://authenticator:pgbase_dev_only@localhost:55432/pgb
 *   ADMIN_DATABASE_URL  postgres://postgres:postgres@localhost:55432/pgb (migrations only)
 *   PORT                3000
 *   BETTER_AUTH_SECRET  32+ char secret (generate with `openssl rand -base64 32`)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { createPgbase, PgbaseError } from "../src/index.ts";

const isMigration = process.argv[2] === "migrate";
const connectionString = isMigration
  ? (process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/pgb")
  : (process.env.DATABASE_URL ?? "postgres://authenticator:pgbase_dev_only@localhost:55432/pgb");
const port = Number(process.env.PORT ?? 3000);

// One Kysely instance, shared by Better Auth and pgbase.
const pool = new Pool({ connectionString });
const database = new Kysely({ dialect: new PostgresDialect({ pool }) });

/**
 * Better Auth owns user roles through its admin plugin. The runtime DB account
 * is deliberately not a superuser; `getSession` maps app roles to a tiny
 * allowlist of Postgres roles below.
 */
export const auth = betterAuth({
  // Better Auth wants the Kysely instance wrapped with its dialect type.
  database: { db: database, type: "postgres" },
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-at-least-32-chars",
  emailAndPassword: { enabled: true },
  plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
  // The migration command intentionally starts before the auth tables exist.
  advanced: { database: { validateSchema: !isMigration } },
});

function postgresRole(appRole: unknown): string {
  const roles = Array.isArray(appRole)
    ? appRole
    : typeof appRole === "string"
      ? appRole.split(",")
      : [];
  if (roles.includes("admin")) return "app_admin";
  if (roles.includes("user")) return "authenticated";
  throw new PgbaseError("PGRST302", "User has no supported application role", 403);
}

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
  schemaName: "app",
  extraSearchPath: ["public"],
  basePath: "/rest",
  maxRows: 1000,
  anonRole: "anon",

  getSession: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    return {
      // Never pass a Better Auth role directly through as a Postgres role.
      role: postgresRole((session.user as { role?: unknown }).role),
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

/** Migrations run with the separate administrative connection. */
if (isMigration) {
  const ctx = await auth.$context;
  await ctx.runMigrations();
  await pool.query(`
    grant select, insert, update, delete on "user", "session", "account", "verification" to authenticator;
    grant usage, select on all sequences in schema public to authenticator;
  `);
  console.log("[pgbase] Better Auth schema is up to date");
  await database.destroy();
} else {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`http://localhost:${info.port}`);
    console.log(`  auth    http://localhost:${info.port}/api/auth/*`);
    console.log(`  pgbase  http://localhost:${info.port}/rest/*`);
  });
}
