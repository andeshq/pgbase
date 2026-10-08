import { describe, test } from "node:test";
import { expect } from "./expect.ts";
import { parseSelect } from "../src/parse/select.ts";
import { parseCondition, parseLogicParam } from "../src/parse/filter.ts";
import { parseMutation, parsePrefer, parseRequest } from "../src/parse/request.ts";

describe("parseSelect", () => {
  test("plain columns", () => {
    expect(parseSelect("id,name")).toEqual([
      { kind: "column", column: "id", alias: undefined, cast: undefined, jsonPath: undefined },
      { kind: "column", column: "name", alias: undefined, cast: undefined, jsonPath: undefined },
    ]);
  });

  test("defaults to star when empty", () => {
    expect(parseSelect("*")).toEqual([{ kind: "column", column: "*", star: true }]);
  });

  test("alias, cast and json path", () => {
    const nodes = parseSelect("full_name:name,id::text,meta->>isbn");
    expect(nodes[0]).toMatchObject({ column: "name", alias: "full_name" });
    expect(nodes[1]).toMatchObject({ column: "id", cast: "text" });
    expect(nodes[2]).toMatchObject({ column: "meta", jsonPath: ["isbn"] });
  });

  test("embed with alias, hint and inner", () => {
    const nodes = parseSelect("author:users!author_id!inner(id,name)");
    expect(nodes[0]).toMatchObject({
      kind: "embed",
      relation: "users",
      alias: "author",
      hint: "author_id",
      inner: true,
      path: "author",
    });
    expect((nodes[0] as any).children).toHaveLength(2);
  });

  test("nested embeds", () => {
    const nodes = parseSelect("name,books(title,author(name))");
    const books = nodes[1] as any;
    expect(books.kind).toBe("embed");
    expect(books.path).toBe("books");
    const author = books.children[1];
    expect(author.kind).toBe("embed");
    expect(author.path).toBe("author");
  });
});

describe("parseCondition", () => {
  test("scalar operator", () => {
    expect(parseCondition("age.gt.20")).toMatchObject({ column: "age", op: "gt", value: "20", negate: false });
  });

  test("negation", () => {
    expect(parseCondition("age.not.eq.5")).toMatchObject({ column: "age", op: "eq", value: "5", negate: true });
  });

  test("quoted value with commas", () => {
    expect(parseCondition('name.eq."Doe, John"')).toMatchObject({ column: "name", value: "Doe, John" });
  });

  test("in list", () => {
    expect(parseCondition("id.in.(1,2,3)")).toMatchObject({ op: "in", value: ["1", "2", "3"] });
  });

  test("contains set", () => {
    expect(parseCondition("tags.cs.{a,b}")).toMatchObject({ op: "cs", value: ["a", "b"] });
  });

  test("is null / true", () => {
    expect(parseCondition("deleted_at.is.null")).toMatchObject({ op: "is", value: "null" });
    expect(parseCondition("active.is.true")).toMatchObject({ op: "is", value: "true" });
    expect(parseCondition("deleted_at.not.is.null")).toMatchObject({ op: "is", value: "null", negate: true });
  });

  test("full text search with config", () => {
    expect(parseCondition("body.fts(english).cat")).toMatchObject({ op: "fts", tsConfig: "english", value: "cat" });
  });

  test("json path column", () => {
    expect(parseCondition("meta->>isbn.eq.123")).toMatchObject({
      column: "meta",
      jsonPath: ["isbn"],
      op: "eq",
      value: "123",
    });
  });

  test("nested logic", () => {
    const node = parseLogicParam("or", false, "(and(a.eq.1,b.eq.2),c.eq.3)");
    expect(node.kind).toBe("logic");
    const children = (node as any).children;
    expect(children[0].kind).toBe("logic");
    expect(children[0].op).toBe("and");
    expect(children[1]).toMatchObject({ column: "c", op: "eq" });
  });
});

describe("parseRequest", () => {
  test("routes embed filters, order, limit and headers", () => {
    const request = new Request(
      "http://localhost/authors?select=name,books(title)&books.published=eq.true&order=name.asc&limit=10&offset=5",
      { headers: { prefer: "count=exact", accept: "application/vnd.pgrst.object+json" } },
    );
    const parsed = parseRequest(request, "public", "authors");
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(5);
    expect(parsed.count).toBe("exact");
    expect(parsed.singular).toBe(true);
    expect(parsed.order).toEqual([
      { column: "name", direction: "asc", nulls: undefined, jsonPath: undefined, cast: undefined },
    ]);
    const books = parsed.embeds.get("books");
    expect(books?.filters).toHaveLength(1);
    expect(books?.filters[0]).toMatchObject({ column: "published", op: "eq", value: "true" });
  });

  test("Range header drives offset/limit and ranged flag", () => {
    const request = new Request("http://localhost/books", { headers: { range: "10-19" } });
    const parsed = parseRequest(request, "public", "books");
    expect(parsed.offset).toBe(10);
    expect(parsed.limit).toBe(10);
    expect(parsed.ranged).toBe(true);
  });

  test("embedded order/limit control params", () => {
    const request = new Request(
      "http://localhost/authors?select=name,books(title)&books.order=title.desc.nullslast&books.limit=3",
    );
    const parsed = parseRequest(request, "public", "authors");
    const books = parsed.embeds.get("books");
    expect(books?.limit).toBe(3);
    expect(books?.order[0]).toMatchObject({ column: "title", direction: "desc", nulls: "last" });
  });

  test("Range header is ignored for write methods", () => {
    const request = new Request("http://localhost/books", {
      method: "PATCH",
      headers: { range: "0-4" },
    });
    const parsed = parseMutation(request, "public", "books", "PATCH");
    expect(parsed.offset).toBeUndefined();
    expect(parsed.limit).toBeUndefined();
    expect(parsed.ranged).toBe(false);
    expect(parsed.rangeLimited).toBe(false);
  });

  test("Range header intersects the limit parameter", () => {
    const request = new Request("http://localhost/books?limit=3", { headers: { range: "0-1" } });
    const parsed = parseRequest(request, "public", "books");
    expect(parsed.limit).toBe(2);
    expect(parsed.offset).toBeUndefined();
  });

  test("malformed Range headers are ignored", () => {
    const request = new Request("http://localhost/books", { headers: { range: "abc" } });
    const parsed = parseRequest(request, "public", "books");
    expect(parsed.limit).toBeUndefined();
    expect(parsed.ranged).toBe(false);
  });

  test("negative offset is a no-op, negative limit is PGRST103", () => {
    const offset = parseRequest(
      new Request("http://localhost/books?offset=-4"),
      "public",
      "books",
    );
    expect(offset.offset).toBeUndefined();

    const limit = new Request("http://localhost/books?limit=-1");
    let code: string | undefined;
    try {
      parseRequest(limit, "public", "books");
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("PGRST103");
  });

  test("non-numeric limit/offset values are ignored", () => {
    const parsed = parseRequest(new Request("http://localhost/books?limit=x&offset=y"), "public", "books");
    expect(parsed.limit).toBeUndefined();
    expect(parsed.offset).toBeUndefined();
  });

  test("canonical query is alphabetized and re-encoded", () => {
    const parsed = parseRequest(
      new Request("http://localhost/books?b=eq.1&a=eq.h%C3%A9llo&select=id"),
      "public",
      "books",
    );
    expect(parsed.canonicalQuery).toBe("a=eq.h%C3%A9llo&b=eq.1&select=id");
  });

  test("writes negotiate the profile with Content-Profile", () => {
    const request = new Request("http://localhost/books", {
      method: "PATCH",
      headers: { "content-profile": "api", "accept-profile": "other" },
    });
    const parsed = parseMutation(request, "public", "books", "PATCH");
    expect(parsed.profile).toBe("api");
  });
});

describe("parsePrefer", () => {
  test("only explicitly requested preferences are recorded", () => {
    const prefer = parsePrefer(null);
    expect(prefer.return).toBeNull();
    expect(prefer.count).toBeNull();
    expect(prefer.handling).toBeNull();
    expect(prefer.invalid).toEqual([]);
  });

  test("first occurrence wins and unknown tokens are collected", () => {
    const prefer = parsePrefer("return=representation, return=minimal, anything");
    expect(prefer.return).toBe("representation");
    expect(prefer.invalid).toEqual(["anything"]);
  });

  test("handling=strict rejects invalid preferences with PGRST122", () => {
    let error: { code?: string; details?: string | null } | undefined;
    try {
      parsePrefer("handling=strict, something, else");
    } catch (thrown) {
      error = thrown as typeof error;
    }
    expect(error?.code).toBe("PGRST122");
    expect(error?.details).toBe("Invalid preferences: something, else");
  });

  test("handling=lenient keeps invalid preferences but does not throw", () => {
    const prefer = parsePrefer("handling=lenient, anything");
    expect(prefer.handling).toBe("lenient");
    expect(prefer.invalid).toEqual(["anything"]);
  });

  test("max-affected, tx, timezone and missing=null are recognized", () => {
    const prefer = parsePrefer("max-affected=10, tx=commit, timezone=UTC, missing=null");
    expect(prefer.maxAffected).toBe(10);
    expect(prefer.missing).toBe("null");
    expect(prefer.invalid).toEqual([]);
  });

  test("tx is only parsed when overrides are allowed", () => {
    expect(parsePrefer("tx=rollback").transaction).toBeNull();
    expect(parsePrefer("tx=rollback", true).transaction).toBe("rollback");
  });

  test("timezone is captured for the session", () => {
    const prefer = parsePrefer("timezone=America/Los_Angeles");
    expect(prefer.timezone).toBe("America/Los_Angeles");
    expect(prefer.invalid).toEqual([]);
  });
});
