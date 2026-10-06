import assert from "node:assert/strict";
import { SQL } from "bun";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import { createPgbase } from "../src/index.ts";

const connectionString = process.env.PGB_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("Set PGB_TEST_DATABASE_URL to a disposable Postgres database before running this test");
}

const schema = "pgbase_bun_driver_test";
const adminSql = new SQL(connectionString);
let db;

try {
  await adminSql`DO $$ BEGIN CREATE ROLE anon nologin; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
  await adminSql`DO $$ BEGIN CREATE ROLE authenticated nologin; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
  await adminSql`DROP SCHEMA IF EXISTS pgbase_bun_driver_test CASCADE`;
  await adminSql`CREATE SCHEMA pgbase_bun_driver_test`;
  await adminSql`CREATE TABLE pgbase_bun_driver_test.locked (id integer primary key, value text not null)`;
  await adminSql`GRANT USAGE ON SCHEMA pgbase_bun_driver_test TO authenticated`;

  const bunSql = new SQL(connectionString);
  db = new Kysely({ dialect: new PostgresJSDialect({ postgres: bunSql }) });
  const pgbase = createPgbase({
    database: db,
    schemaName: schema,
    basePath: "/rest",
    getSession: () => ({ role: "authenticated", sub: "bun-driver-test" }),
  });

  const response = await pgbase.handler(
    new Request("http://localhost/rest/locked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, value: "denied" }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, "42501");
  console.log("Bun SQL permission denial maps to HTTP 403 / SQLSTATE 42501");
} finally {
  await db?.destroy();
  await adminSql`DROP SCHEMA IF EXISTS pgbase_bun_driver_test CASCADE`;
  await adminSql.close();
}
