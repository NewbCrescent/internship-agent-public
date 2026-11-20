import type { DatabaseSync } from "node:sqlite";

import { getReviewFocus, saveReviewFocus } from "@internship-agent/db";
import { reviewFocusSchema, type ReviewFocus } from "@internship-agent/domain";

export function getReviewFocusSettings(database: DatabaseSync): ReviewFocus {
  return getReviewFocus(database);
}

/** Validates untrusted settings. Never touches preferences, so AI scores stay current. */
export function saveReviewFocusSettings(database: DatabaseSync, input: unknown): ReviewFocus {
  return saveReviewFocus(database, reviewFocusSchema.parse(input));
}
