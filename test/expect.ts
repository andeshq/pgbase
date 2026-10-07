import assert from "node:assert/strict";

/**
 * A tiny `expect`-shaped wrapper over `node:assert/strict`, so tests read the
 * same as before while running on the Node built-in test runner.
 */
export function expect(actual: unknown): {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: Record<string, unknown>): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  not: {
    toBe(expected: unknown): void;
    toBeNull(): void;
  };
  toBeUndefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toHaveLength(expected: number): void;
  toThrow(expected?: RegExp | Error): void;
} {
  return {
    toBe: (expected) => assert.equal(actual, expected),
    toEqual: (expected) => assert.deepEqual(stripUndefined(actual), stripUndefined(expected)),
    toMatchObject: (expected) => {
      assert.ok(
        actual !== null && typeof actual === "object",
        `expected an object to match ${JSON.stringify(expected)}`,
      );
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual((actual as Record<string, unknown>)[key], value, `property "${key}"`);
      }
    },
    toContain: (expected) => {
      if (typeof actual === "string") assert.ok(actual.includes(expected as string));
      else assert.ok((actual as any[]).includes(expected));
    },
    toMatch: (expected) => assert.match(String(actual), expected),
    toBeGreaterThan: (expected) => assert.ok((actual as number) > expected),
    toBeGreaterThanOrEqual: (expected) => assert.ok((actual as number) >= expected),
    not: {
      toBe: (expected) => assert.notEqual(actual, expected),
      toBeNull: () => assert.notEqual(actual, null),
    },
    toBeUndefined: () => assert.equal(actual, undefined),
    toBeNull: () => assert.equal(actual, null),
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toHaveLength: (expected) => assert.equal((actual as { length: number }).length, expected),
    toThrow: (expected) => assert.throws(actual as () => unknown, expected as never),
  };
}

export { assert };

/**
 * Recursively drop object keys whose value is `undefined`, matching the
 * `toEqual` semantics the suite was written against (Node's `deepStrictEqual`
 * treats `{ a: undefined }` and `{}` as different).
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = stripUndefined(entry);
    }
    return out;
  }
  return value;
}
