/**
 * Internal aliases used in `RETURNING`/derived-table clauses. Prefixed with
 * `pgb_` and namespaced so they cannot collide with real column names.
 */
export const KEY_PREFIX = "pgb_key_";
export const INSERTED_ALIAS = "pgb_inserted";
export const AFFECTED_ALIAS = "pgb_ok";
export const RPC_ALIAS = "pgb_rpc";

export function keyAlias(column: string): string {
  return `${KEY_PREFIX}${column}`;
}
