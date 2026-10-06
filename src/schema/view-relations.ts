import type { PgbaseColumn, PgbaseForeignKey } from "../types.ts";

export interface ViewDefinition {
  name: string;
  definition: string | null;
}

interface ViewSource {
  table: string;
  alias: string;
}

/**
 * Infer view relationships only when the view directly projects the FK columns
 * from referenced base relations. Expressions, unions, subqueries, and
 * ambiguous projections are deliberately ignored rather than guessed.
 */
export function inferViewForeignKeys(
  views: ViewDefinition[],
  columnsByTable: Map<string, PgbaseColumn[]>,
  foreignKeys: PgbaseForeignKey[],
): PgbaseForeignKey[] {
  const inferred: PgbaseForeignKey[] = [];
  const sourcesByView = new Map<string, ViewSource[]>();
  const columnsByView = new Map<string, Map<string, Map<string, string>>>();

  for (const view of views) {
    const parsed = parseSimpleProjection(view.definition, columnsByTable);
    if (parsed) {
      sourcesByView.set(view.name, parsed.sources);
      columnsByView.set(view.name, parsed.columnsBySource);
    }
  }

  const seen = new Set(foreignKeys.map(foreignKeyIdentity));
  // A view can be based on another view, so propagate relationships until no
  // new edges are discovered. The iteration is bounded by the view count.
  for (let pass = 0; pass < views.length; pass++) {
    let changed = false;
    const candidates = [...foreignKeys, ...inferred];

    for (const view of views) {
      const sources = sourcesByView.get(view.name);
      const projections = columnsByView.get(view.name);
      if (!sources || !projections) continue;

      for (const source of sources) {
        const projected = projections.get(source.alias);
        if (!projected) continue;

        for (const fk of candidates) {
          if (fk.fromTable === source.table) {
            const viewColumns = fk.fromColumns.map((column) => projected.get(column));
            if (viewColumns.every((column): column is string => column !== undefined)) {
              changed = addInferred(
                inferred,
                seen,
                {
                  constraint: `${view.name}_${fk.constraint}`,
                  fromTable: view.name,
                  fromColumns: viewColumns,
                  toTable: fk.toTable,
                  toColumns: fk.toColumns,
                },
              ) || changed;
            }
          }

          if (fk.toTable === source.table) {
            const viewColumns = fk.toColumns.map((column) => projected.get(column));
            if (viewColumns.every((column): column is string => column !== undefined)) {
              changed = addInferred(
                inferred,
                seen,
                {
                  constraint: `${view.name}_${fk.constraint}`,
                  fromTable: fk.fromTable,
                  fromColumns: fk.fromColumns,
                  toTable: view.name,
                  toColumns: viewColumns,
                },
              ) || changed;
            }
          }
        }
      }
    }

    if (!changed) break;
  }

  return inferred;
}

function addInferred(
  inferred: PgbaseForeignKey[],
  seen: Set<string>,
  fk: PgbaseForeignKey,
): boolean {
  const identity = foreignKeyIdentity(fk);
  if (seen.has(identity)) return false;
  seen.add(identity);
  inferred.push(fk);
  return true;
}

function foreignKeyIdentity(fk: PgbaseForeignKey): string {
  return JSON.stringify([fk.fromTable, fk.fromColumns, fk.toTable, fk.toColumns]);
}

function parseSimpleProjection(
  definition: string | null,
  columnsByTable: Map<string, PgbaseColumn[]>,
): { sources: ViewSource[]; columnsBySource: Map<string, Map<string, string>> } | null {
  if (!definition || definition.includes("'") || /\bunion\b/i.test(definition)) return null;
  const selectEnd = findTopLevelKeyword(definition, "from");
  if (selectEnd < 0 || !/^\s*select\b/i.test(definition)) return null;

  const selectStart = definition.search(/\bselect\b/i) + "select".length;
  const projections = splitSelectItems(definition.slice(selectStart, selectEnd));
  const fromClause = definition.slice(selectEnd + "from".length).trim();
  if (!projections || fromClause.includes("(") || hasTopLevelComma(fromClause)) return null;

  const sources = parseSources(`FROM ${fromClause}`);
  if (sources.length === 0) return null;

  const result = new Map<string, Map<string, string>>();
  const ambiguousSources = new Set<string>();
  const sourcesByTable = new Map<string, ViewSource[]>();
  for (const source of sources) {
    const sameTable = sourcesByTable.get(source.table) ?? [];
    sameTable.push(source);
    sourcesByTable.set(source.table, sameTable);
  }
  for (const [table, tableSources] of sourcesByTable) {
    if (tableSources.length > 1) ambiguousSources.add(table);
  }

  for (const projection of projections) {
    const parsed = parseDirectProjection(projection);
    if (!parsed) continue;
    let source: ViewSource | undefined;
    if (parsed.qualifier) {
      source = sources.find((candidate) => candidate.alias === parsed.qualifier || candidate.table === parsed.qualifier);
    } else {
      const matches = sources.filter((candidate) =>
        (columnsByTable.get(candidate.table) ?? []).some((column) => column.name === parsed.sourceColumn),
      );
      if (matches.length === 1) source = matches[0];
    }
    if (!source || ambiguousSources.has(source.table)) continue;

    const byColumn = result.get(source.alias) ?? new Map<string, string>();
    const previous = byColumn.get(parsed.sourceColumn);
    if (previous !== undefined && previous !== parsed.outputColumn) {
      byColumn.delete(parsed.sourceColumn);
      ambiguousSources.add(source.table);
      continue;
    }
    byColumn.set(parsed.sourceColumn, parsed.outputColumn);
    result.set(source.alias, byColumn);
  }

  for (const table of ambiguousSources) {
    for (const source of sourcesByTable.get(table) ?? []) result.delete(source.alias);
  }
  return { sources, columnsBySource: result };
}

function parseDirectProjection(
  projection: string,
): { qualifier?: string; sourceColumn: string; outputColumn: string } | null {
  let expression = projection.trim();
  let outputColumn: string | undefined;
  const alias = /^(.*?)\s+as\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)$/i.exec(expression);
  if (alias) {
    expression = alias[1]!.trim();
    outputColumn = unquoteIdentifier(alias[2]!);
  }
  const parts = parseIdentifierPath(expression);
  if (!parts || parts.length < 1 || parts.length > 2) return null;
  const sourceColumn = parts.at(-1)!;
  return {
    qualifier: parts.length === 2 ? parts[0] : undefined,
    sourceColumn,
    outputColumn: outputColumn ?? sourceColumn,
  };
}

function parseSources(fromClause: string): ViewSource[] {
  const sourcePattern = new RegExp(
    `\\b(?:from|join)\\s+((?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER})(?:\\s+(?:as\\s+)?(${IDENTIFIER}))?`,
    "gi",
  );
  const sources: ViewSource[] = [];
  const reserved = new Set([
    "where", "join", "inner", "left", "right", "full", "cross", "natural", "on", "using",
    "group", "order", "limit", "offset", "fetch", "for", "window",
  ]);

  for (const match of fromClause.matchAll(sourcePattern)) {
    const nameParts = parseIdentifierPath(match[1]!);
    if (!nameParts) return [];
    const table = nameParts.at(-1)!;
    const candidateAlias = match[2] ? unquoteIdentifier(match[2]) : undefined;
    const alias = candidateAlias && !reserved.has(candidateAlias.toLowerCase()) ? candidateAlias : table;
    sources.push({ table, alias });
  }
  return sources;
}

const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';

function parseIdentifierPath(value: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index++;
    if (value[index] === '"') {
      let end = index + 1;
      let identifier = "";
      while (end < value.length) {
        if (value[end] === '"' && value[end + 1] === '"') {
          identifier += '"';
          end += 2;
        } else if (value[end] === '"') {
          end++;
          break;
        } else {
          identifier += value[end]!;
          end++;
        }
      }
      if (end > value.length || value[end - 1] !== '"') return null;
      parts.push(identifier);
      index = end;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(value.slice(index));
      if (!match) return null;
      parts.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(value[index] ?? "")) index++;
    if (index === value.length) break;
    if (value[index] !== ".") return null;
    index++;
  }
  return parts;
}

function unquoteIdentifier(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/""/g, '"')
    : value;
}

function splitSelectItems(input: string): string[] | null {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "single" | "double" | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote === "single") {
      if (char === "'" && input[i + 1] === "'") i++;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"' && input[i + 1] === '"') i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      result.push(input.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) return null;
  }
  if (quote || depth !== 0) return null;
  result.push(input.slice(start).trim());
  return result.filter(Boolean);
}

function findTopLevelKeyword(input: string, keyword: string): number {
  let depth = 0;
  let quote: "single" | "double" | null = null;
  for (let i = 0; i <= input.length - keyword.length; i++) {
    const char = input[i]!;
    if (quote === "single") {
      if (char === "'" && input[i + 1] === "'") i++;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"' && input[i + 1] === '"') i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    if (depth !== 0) continue;
    if (input.slice(i, i + keyword.length).toLowerCase() !== keyword) continue;
    const before = input[i - 1] ?? " ";
    const after = input[i + keyword.length] ?? " ";
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return i;
  }
  return -1;
}

function hasTopLevelComma(input: string): boolean {
  let depth = 0;
  let quote: "single" | "double" | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote === "single") {
      if (char === "'" && input[i + 1] === "'") i++;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"' && input[i + 1] === '"') i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}
