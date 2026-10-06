import { describe, test } from "node:test";
import { expect } from "./expect.ts";
import { fromPostgresError } from "../src/errors.ts";

/**
 * The SQLSTATE's location is driver-specific: node-postgres and postgres.js put
 * it in `code`, while Bun SQL sets `code` to a generic `ERR_POSTGRES_SERVER_ERROR`
 * and puts the SQLSTATE in `errno`. These tests pin the mapping regardless.
 */
describe("error mapping", () => {
  test("42501 is 403 when authenticated, 401 otherwise (pg shape)", () => {
    const err = { code: "42501", message: "permission denied for table items" };
    expect(fromPostgresError(err, "verbose", true).status).toBe(403);
    expect(fromPostgresError(err, "verbose", false).status).toBe(401);
  });

  test("reads the SQLSTATE from errno when the driver's code is generic (Bun SQL)", () => {
    const err = {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "42501",
      message: "permission denied for table items",
    };
    const authenticated = fromPostgresError(err, "verbose", true);
    expect(authenticated.status).toBe(403);
    expect(authenticated.code).toBe("42501");
    expect(fromPostgresError(err, "verbose", false).status).toBe(401);
  });

  test("RLS with-check violations follow the same 42501 rule", () => {
    const err = {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "42501",
      message: 'new row violates row-level security policy for table "notes"',
    };
    expect(fromPostgresError(err, "verbose", true).status).toBe(403);
    expect(fromPostgresError(err, "verbose", false).status).toBe(401);
  });

  test("0P/0L/28 classes map to 403 rather than 500", () => {
    for (const errno of ["0P000", "0L000", "28000"]) {
      const mapped = fromPostgresError(
        { code: "ERR_POSTGRES_SERVER_ERROR", errno, message: "invalid spec" },
        "verbose",
        false,
      );
      expect(mapped.status).toBe(403);
    }
  });

  test("a codeless permission-denied error is not a 500", () => {
    const err = { message: "permission denied for table items" };
    expect(fromPostgresError(err, "verbose", true).status).toBe(403);
    expect(fromPostgresError(err, "verbose", false).status).toBe(401);
  });

  test("known SQLSTATEs keep their mapping", () => {
    expect(fromPostgresError({ code: "23505", message: "duplicate" }, "verbose", false).status).toBe(409);
    expect(fromPostgresError({ code: "42P01", message: "missing" }, "verbose", false).status).toBe(404);
  });

  test("known non-updatable-view errors map to 405 without remapping all 55000s", () => {
    const viewError = fromPostgresError(
      { code: "55000", message: "Views that do not select from a single table or view are not automatically updatable" },
    );
    expect(viewError.status).toBe(405);
    expect(fromPostgresError({ code: "55000", message: "other prerequisite state" }).status).toBe(500);
  });

  test("unknown errors still map to 500", () => {
    expect(fromPostgresError({ message: "boom" }, "verbose", false).status).toBe(500);
  });
});
