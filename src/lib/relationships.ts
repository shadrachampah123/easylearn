/**
 * Relationship labels shared by the admin parent-learner linking UI and the
 * /api/parent-learners routes. `parent_learners.relationship` is free text in the
 * database, so the API only enforces the length limit - this list keeps the data tidy.
 */
export const RELATIONSHIP_OPTIONS = [
  "mother",
  "father",
  "guardian",
  "aunt",
  "uncle",
  "grandmother",
  "grandfather",
  "sibling",
  "foster parent",
  "other",
] as const;

export type RelationshipOption = (typeof RELATIONSHIP_OPTIONS)[number];

export const RELATIONSHIP_LABELS: Record<string, string> = {
  mother: "Mother",
  father: "Father",
  guardian: "Guardian",
  aunt: "Aunt",
  uncle: "Uncle",
  grandmother: "Grandmother",
  grandfather: "Grandfather",
  sibling: "Sibling",
  "foster parent": "Foster parent",
  other: "Other",
};

export function relationshipLabel(value: string | null | undefined): string {
  if (!value) return "Guardian";
  return RELATIONSHIP_LABELS[value.toLowerCase()] ?? value;
}

/** Normalise free-text input into the stored form, or null when it is unusable. */
export function normalizeRelationship(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text.length > 50) return null;
  return text;
}
