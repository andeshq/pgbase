/** Small parsing helpers shared by the select/filter/order parsers. */

/**
 * Split on `separator` only when it is outside quotes and outside `()`, `{}`
 * and `[]`. Separator is a single character.
 */
export function splitTopLevel(input: string, separator = ","): string[] {
  const out: string[] = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      current += ch;
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      current += ch;
      continue;
    }
    if (ch === "(") depthParen++;
    else if (ch === ")") depthParen--;
    else if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace--;
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket--;
    if (ch === separator && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Remove surrounding double quotes and unescape `\"` / `\\`. */
export function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

/** Strip one layer of surrounding parentheses. */
export function stripParens(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) return trimmed.slice(1, -1);
  return trimmed;
}

const CAST_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$/;

export function isValidCast(cast: string): boolean {
  return CAST_RE.test(cast);
}

/** Index of the first top-level `(` or -1. */
export function findOpenParen(input: string): number {
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") return i;
  }
  return -1;
}
