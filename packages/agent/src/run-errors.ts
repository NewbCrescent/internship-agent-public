/** Raised when an automatic run cannot fill anything useful; the job keeps its status and is not retried. */
export class AutomaticRunStopped extends Error {}

/** Thrown when the site shows a sign-in form: the session is marked signed out and the pipeline waits. */
export class WorkdaySignInRequired extends Error {}

/**
 * A Workday account step (create, sign in, verify the email) is held for the
 * candidate or for a later pass. The job keeps its status and is retried once
 * the hold allows (see `workdayAccountWait`).
 */
export class WorkdayAccountHeld extends WorkdaySignInRequired {}
