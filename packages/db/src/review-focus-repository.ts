import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_REVIEW_FOCUS, reviewFocusSchema, type ReviewFocus } from "@internship-agent/domain";

/** The saved focus, or the default when none is saved or the saved row no longer validates. */
export function getReviewFocus(database: DatabaseSync): ReviewFocus {
  const row = database.prepare("SELECT settings_json FROM review_focus WHERE id = 1").get() as { settings_json: string } | undefined;
  if (!row) return DEFAULT_REVIEW_FOCUS;
  try {
    const parsed = reviewFocusSchema.safeParse(JSON.parse(row.settings_json));
    return parsed.success ? parsed.data : DEFAULT_REVIEW_FOCUS;
  } catch {
    return DEFAULT_REVIEW_FOCUS;
  }
}

export function saveReviewFocus(database: DatabaseSync, focus: ReviewFocus): ReviewFocus {
  const parsed = reviewFocusSchema.parse(focus);
  database.prepare(`
    INSERT INTO review_focus (id, settings_json, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(parsed), new Date().toISOString());
  return parsed;
}
