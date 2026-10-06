import { after as afterAll, before as beforeAll, describe, test } from "node:test";
import { EventEmitter } from "node:events";
import { expect } from "./expect.ts";
import { Client, Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { createPgbase } from "../src/index.ts";
import { startSchemaListener } from "../src/schema-listener.ts";

test("listener reports an asynchronous schema reload failure", async () => {
  const client: any = new EventEmitter();
  client.query = async () => undefined;
  client.end = async () => undefined;
  const failure = new Error("introspection unavailable");
  let reported: unknown;
  const listener = await startSchemaListener(client, {
    onReload: async () => {
      throw failure;
    },
    onError: (error) => {
      reported = error;
    },
  });
  client.emit("notification", { channel: "pgrst", payload: "reload schema" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reported).toBe(failure);
  await listener.stop();
});

const DATABASE_URL = process.env.PGB_TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

suite("schema NOTIFY listener", () => {
  let client: Client;
  let pool: Pool;
  let db: Kysely<any>;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`
      do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      drop schema if exists note cascade;
      create schema note;
      grant usage on schema note to anon, authenticated;
      create table note.t (id serial primary key, name text not null);
      grant select on note.t to anon, authenticated;
    `);

    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    await db?.destroy();
    await client?.end();
  });

  test("NOTIFY pgrst reloads the schema cache", async () => {
    const pgbase = createPgbase({
      database: db,
      schemaName: "note",
      basePath: "/api",
      anonRole: "anon",
      refreshOnNotify: true,
      createListenClient: async () => {
        const listenClient = new Client({ connectionString: DATABASE_URL });
        await listenClient.connect();
        return listenClient;
      },
    } as any);

    const before = await pgbase.schema();
    expect(before.tables.has("t")).toBe(true);
    expect(before.tables.has("late")).toBe(false);

    const listener = await pgbase.listen();

    // Create a new relation, then notify. The listener should re-introspect.
    await client.query("create table note.late (id serial primary key)");
    await client.query("notify pgrst, 'reload schema'");

    // Give the notification a moment to round-trip.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await pgbase.schema();
    expect(after.tables.has("late")).toBe(true);

    await listener.stop();
    await client.query("drop table if exists note.late");
  });

  test("listener is a no-op without refreshOnNotify", async () => {
    const pgbase = createPgbase({ database: db, schemaName: "note", basePath: "/api" } as any);
    const handle = await pgbase.listen();
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });
});
