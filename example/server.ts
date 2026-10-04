import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { createPgb, PgbError } from "../src/index.ts";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/pgb";

const pool = new Pool({ connectionString });
const database = new Kysely({ dialect: new PostgresDialect({ pool }) });

const pgb = createPgb({
  database,
  schemaName: "public",
  extraSearchPath: ["public"],
  basePath: "/rest/v1",
  maxRows: 1000,
  anonRole: "anon",

  /**
   * Resolve the request's database identity as a claim object. pgb is
   * auth-agnostic: verify a session/JWT/API key however you like and return the
   * claims. `role` is required (the Postgres role to impersonate); every other
   * key is exposed to Postgres as `request.jwt.claims`.
   *
   *   return null     -> anonymous (anonRole)
   *   return { role } -> SET LOCAL ROLE + request.jwt.claim.*
   *   throw           -> error response (throw PgbError for 401)
   */
  getSession: (request) => {
    // Demo: read identity from headers. Replace with your real auth.
    const sub = request.headers.get("x-sub");
    if (!sub) return null;
    if (sub === "invalid") {
      throw new PgbError("PGRST301", "Invalid token", 401);
    }
    return {
      role: request.headers.get("x-role") ?? "authenticated",
      sub,
      email: `${sub}@example.com`,
    };
  },

  onError: (error) => {
    console.error("[pgb]", error);
  },

  debug: true,
});

/** Adapt a Node `IncomingMessage` into a web-standard `Request`. */
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
    else headers.set(key, value);
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method, headers, body });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Write a web-standard `Response` back to a Node `ServerResponse`. */
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  res.end(body ?? undefined);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const request = await toWebRequest(req);
      await sendWebResponse(res, await pgb.handler(request));
    } catch (error) {
      console.error("[pgb] adapter error", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  })();
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`pgb listening on http://localhost:${port}/rest/v1`);
});
