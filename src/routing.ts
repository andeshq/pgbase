import type { WriteMethod } from "./ast.ts";

/** Normalize a mount path: `undefined`/`/` -> `""`, otherwise leading-slash, no trailing slash. */
export function normalizeBasePath(path: string | undefined): string {
  if (!path || path === "/") return "";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.replace(/\/+$/, "");
}

/**
 * Strip the mount path from a request pathname and return the remainder
 * (without a leading slash), or `null` when the request is outside the mount.
 */
export function matchBasePath(pathname: string, basePath: string): string | null {
  if (basePath === "") return pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (pathname === basePath) return "";
  if (pathname.startsWith(basePath + "/")) return pathname.slice(basePath.length + 1);
  return null;
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function isWriteMethod(method: string): method is WriteMethod {
  return WRITE_METHODS.has(method);
}

/** First schema from a `string | string[]` config value. */
export function firstSchema(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "public";
  return value ?? "public";
}
