import { PgbError } from "../errors.ts";
import type { PgbForeignKey, PgbRelation, PgbSchema } from "../types.ts";

export type Relationship =
  | { kind: "one"; parentColumns: string[]; relatedColumns: string[] }
  | { kind: "many"; parentColumns: string[]; relatedColumns: string[] }
  | {
      kind: "many-to-many";
      junction: string;
      parentColumns: string[];
      junctionParentColumns: string[];
      junctionRelatedColumns: string[];
      relatedColumns: string[];
    };

function describeHints(fks: PgbForeignKey[]): string[] {
  return fks.map((fk) => `${fk.fromTable}.${fk.fromColumns.join("_")}`);
}

/**
 * Resolve how two relations are related, for embedding. Handles to-one,
 * to-many and many-to-many (via a junction table), disambiguated by `hint`.
 */
export function resolveRelationship(
  schema: PgbSchema,
  parent: PgbRelation,
  related: PgbRelation,
  hint?: string,
): Relationship {
  const outgoing = schema.foreignKeys.filter((fk) => fk.fromTable === parent.name && fk.toTable === related.name);
  const incoming = schema.foreignKeys.filter((fk) => fk.fromTable === related.name && fk.toTable === parent.name);

  const matchesHint = (fk: PgbForeignKey) =>
    !hint || fk.constraint === hint || fk.fromColumns.includes(hint) || fk.toColumns.includes(hint);

  if (hint) {
    const matchedOut = outgoing.filter(matchesHint);
    const matchedIn = incoming.filter(matchesHint);
    const all = [
      ...matchedOut.map((fk) => ({ fk, direction: "one" as const })),
      ...matchedIn.map((fk) => ({ fk, direction: "many" as const })),
    ];
    if (all.length === 0) throw PgbError.relationshipNotFound(parent.name, related.name);
    if (all.length > 1) {
      throw PgbError.ambiguousEmbedding(parent.name, related.name, describeHints([...outgoing, ...incoming]));
    }
    const chosen = all[0]!;
    return chosen.direction === "one"
      ? { kind: "one", parentColumns: chosen.fk.fromColumns, relatedColumns: chosen.fk.toColumns }
      : { kind: "many", parentColumns: chosen.fk.toColumns, relatedColumns: chosen.fk.fromColumns };
  }

  if (outgoing.length > 0 && incoming.length > 0) {
    throw PgbError.ambiguousEmbedding(parent.name, related.name, describeHints([...outgoing, ...incoming]));
  }
  if (outgoing.length > 1) {
    throw PgbError.ambiguousEmbedding(parent.name, related.name, describeHints(outgoing));
  }
  if (outgoing.length === 1) {
    const fk = outgoing[0]!;
    return { kind: "one", parentColumns: fk.fromColumns, relatedColumns: fk.toColumns };
  }
  if (incoming.length > 1) {
    throw PgbError.ambiguousEmbedding(parent.name, related.name, describeHints(incoming));
  }
  if (incoming.length === 1) {
    const fk = incoming[0]!;
    return { kind: "many", parentColumns: fk.toColumns, relatedColumns: fk.fromColumns };
  }

  // Many-to-many via a junction table with FKs to both sides.
  const junctions = schema.relations.filter(
    (r) =>
      r.name !== parent.name &&
      r.name !== related.name &&
      schema.foreignKeys.some((fk) => fk.fromTable === r.name && fk.toTable === parent.name) &&
      schema.foreignKeys.some((fk) => fk.fromTable === r.name && fk.toTable === related.name),
  );
  if (junctions.length === 0) throw PgbError.relationshipNotFound(parent.name, related.name);
  if (junctions.length > 1) {
    throw PgbError.ambiguousEmbedding(parent.name, related.name, junctions.map((j) => j.name));
  }
  const junction = junctions[0]!;
  const toParent = schema.foreignKeys.find((fk) => fk.fromTable === junction.name && fk.toTable === parent.name)!;
  const toRelated = schema.foreignKeys.find((fk) => fk.fromTable === junction.name && fk.toTable === related.name)!;
  return {
    kind: "many-to-many",
    junction: junction.name,
    parentColumns: toParent.toColumns,
    junctionParentColumns: toParent.fromColumns,
    junctionRelatedColumns: toRelated.fromColumns,
    relatedColumns: toRelated.toColumns,
  };
}
