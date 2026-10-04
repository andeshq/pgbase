import type { SelectColumn, SelectEmbed, SelectNode } from "../ast.ts";
import { PgbaseError } from "../errors.ts";
import { findOpenParen, isValidCast, splitTopLevel, unquote } from "./util.ts";

/** Parse a PostgREST `select` expression, e.g. `id, author:users!fk(name, email)`. */
export function parseSelect(input: string): SelectNode[] {
  const items = splitTopLevel(input, ",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return [{ kind: "column", column: "*", star: true }];
  return items.map(parseSelectItem);
}

function parseSelectItem(item: string): SelectNode {
  const paren = findOpenParen(item);
  if (paren !== -1 && item.trimEnd().endsWith(")")) {
    return parseEmbed(item, paren);
  }
  return parseColumn(item);
}

function parseEmbed(item: string, paren: number): SelectEmbed {
  let prefix = item.slice(0, paren).trim();
  const inner = item.slice(paren + 1, item.trimEnd().length - 1);

  let spread = false;
  if (prefix.startsWith("...")) {
    spread = true;
    prefix = prefix.slice(3).trim();
  }

  const bangParts = prefix.split("!");
  let head = bangParts[0]!.trim();
  let inner_ = false;
  let hint: string | undefined;
  for (const part of bangParts.slice(1)) {
    const token = part.trim();
    if (token === "inner") inner_ = true;
    else if (token.length > 0) hint = token;
  }

  let alias: string | undefined;
  const colon = head.indexOf(":");
  if (colon !== -1) {
    alias = unquote(head.slice(0, colon));
    head = head.slice(colon + 1).trim();
  }
  const relation = unquote(head);
  if (!relation) throw PgbaseError.parse(`Invalid embedded resource: ${item}`);

  const children = inner.trim().length > 0 ? parseSelect(inner) : [];
  return {
    kind: "embed",
    relation,
    alias,
    hint,
    inner: inner_,
    spread,
    children,
    path: alias ?? relation,
  };
}

function parseColumn(item: string): SelectColumn {
  let s = item.trim();

  let cast: string | undefined;
  const castIdx = s.lastIndexOf("::");
  if (castIdx !== -1) {
    cast = s.slice(castIdx + 2).trim();
    s = s.slice(0, castIdx).trim();
    if (!isValidCast(cast)) throw PgbaseError.parse(`Invalid cast in select: ::${cast}`);
  }

  if (s === "*") return { kind: "column", column: "*", star: true };

  let alias: string | undefined;
  const colon = s.indexOf(":");
  if (colon !== -1 && !s.slice(0, colon).includes("->")) {
    alias = unquote(s.slice(0, colon));
    s = s.slice(colon + 1).trim();
  }

  if (s.includes("->")) {
    const segments = s.split(/->>?/);
    const column = unquote(segments[0]!);
    const jsonPath = segments.slice(1).map((seg) => unquote(seg));
    return { kind: "column", column, alias, cast, jsonPath };
  }

  return { kind: "column", column: unquote(s), alias, cast };
}
