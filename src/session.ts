import { sql, type RawBuilder } from "kysely";

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function serializeClaim(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parse a `Cookie:` header into a `{ name: value }` object (PostgREST stores cookies as JSON). */
export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const raw = pair.slice(eq + 1).trim();
    cookies[name] = decodeURIComponent(raw);
  }
  return cookies;
}

/** Collect request headers as a lowercase-keyed object (PostgREST lowercases names). */
export function collectHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Configure the transaction so Postgres RLS applies exactly as it would under
 * PostgREST: `SET LOCAL ROLE`, a schema search_path, config `settings`, the JWT
 * claims GUCs, and the request-context GUCs (`request.headers`,
 * `request.cookies`, `request.method`, `request.path`).
 */
export async function applySession(
  trx: any,
  searchPath: string[],
  role: string | null,
  claims: Record<string, unknown> | null,
  request: Request,
  path: string,
  settings: Record<string, string | number> = {},
  timezone: string | null = null,
): Promise<void> {
  if (role) {
    await sql`set local role ${sql.id(role)}`.execute(trx);
  }

  const setters: RawBuilder<any>[] = [
    sql`set_config('search_path', ${searchPath.map(quoteIdentifier).join(", ")}, true)`,
    sql`set_config('request.headers', ${JSON.stringify(collectHeaders(request))}, true)`,
    sql`set_config('request.cookies', ${JSON.stringify(parseCookies(request.headers.get("cookie")))}, true)`,
    sql`set_config('request.method', ${request.method.toUpperCase()}, true)`,
    sql`set_config('request.path', ${path}, true)`,
  ];

  if (timezone) {
    // `Prefer: timezone=` applies for the duration of the transaction.
    setters.push(sql`set_config('timezone', ${timezone}, true)`);
  }

  for (const [name, value] of Object.entries(settings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) continue;
    setters.push(sql`set_config(${name}, ${String(value)}, true)`);
  }

  if (claims) {
    setters.push(sql`set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`);
    for (const [key, value] of Object.entries(claims)) {
      if (value === null || value === undefined) continue;
      const guc = `request.jwt.claim.${key}`;
      if (!/^[A-Za-z0-9_.]+$/.test(guc)) continue;
      setters.push(sql`set_config(${guc}, ${serializeClaim(value)}, true)`);
    }
  } else if (role) {
    // PostgREST defaults `role` in the claims to the anon role, so SQL that
    // reads `request.jwt.claims->>'role'` works for unauthenticated requests.
    setters.push(sql`set_config('request.jwt.claims', ${JSON.stringify({ role })}, true)`);
    setters.push(sql`set_config('request.jwt.claim.role', ${role}, true)`);
  }

  await sql`select ${sql.join(setters)}`.execute(trx);
}
