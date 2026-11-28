/**
 * "How did you hear about us?" follows the candidate's own rule: the saved
 * how_heard answer verbatim when it is offered, else a job-board option (the
 * postings came from job lists), else LinkedIn (candidate, 2026-11-19), else
 * another general board, else N/A, else an option named Other (Track 67: the
 * truthful pick when no listed source is a job board), else a seeded
 * non-referral pick. "How did you connect with us?" is the same question. The
 * candidate chose that last fallback; referral-style options are still never
 * picked, since a referral claim invites an employer to contact a referrer who
 * does not exist. The fallback is seeded, so a rerun of the same application
 * gives the same answer.
 */
// "Where did you first hear about this job?" (Track 79): "first" may follow "how did you" or "where did you".
const HEAR_ABOUT = /how did you (?:first )?(hear|learn|find out) (about|of)|how did you find (us|this|out)|where did you (?:first )?(hear|learn|find|see)|how did you (?:first )?connect with us|referral source|^(application |candidate )?source$/i;
const JOB_BOARD = /job ?boards?|job (site|website|posting|search)s?|online job/i;
const LINKEDIN = /\blinked ?in\b/i;
const GENERAL_BOARD = /\b(linkedin|indeed|handshake|glassdoor)\b/i;
const NOT_APPLICABLE = /^(n\/?a|not applicable|none)$/i;
const OTHER = /^other\b/i;
const NEVER = /refer|employee|recruiter|friend|colleague|family|contacted me|contingent worker|currently .*(employed|worker)/i;

export function isHearAboutQuestion(label: string): boolean {
  return HEAR_ABOUT.test(label.replace(/\*+$/, "").trim());
}

function comparable(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export function pickHearAboutOption(options: string[], seed: string, preferred: string | null = null): string | null {
  const usable = options.map((option) => option.trim()).filter((option) => option && !/^select one$/i.test(option));
  if (preferred) {
    const wanted = comparable(preferred);
    const match = usable.find((option) => comparable(option) === wanted && !NEVER.test(option));
    if (match) return match;
  }
  for (const tier of [JOB_BOARD, LINKEDIN, GENERAL_BOARD, NOT_APPLICABLE, OTHER]) {
    const match = usable.find((option) => tier.test(option) && !NEVER.test(option));
    if (match) return match;
  }
  const pool = usable.filter((option) => !NEVER.test(option));
  if (pool.length === 0) return null;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return pool[hash % pool.length]!;
}
