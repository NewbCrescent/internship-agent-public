import type { InvalidField } from "../submission-outcome";

/**
 * Ashby's submit on the network. Source: Ashby's public front-end bundle
 * (index-CY3T4pnC.js, read 2026-11-24, no submission made), checked against a
 * read-only load of one public Ashby application page on 2026-11-24.
 *
 * What Ashby sends: each answer is saved as it is set (`ApiSetFormValue`,
 * `ApiSetFormValueToFile`, `ApiAddManyFilesToFormValue`,
 * `ApiCreateFileUploadHandle`). The submit button first asks reCAPTCHA
 * Enterprise for a token (a POST to recaptcha.net `/recaptcha/enterprise/reload`),
 * then POSTs the mutation `ApiSubmitSingleApplicationFormAction` (with survey
 * forms `ApiSubmitMultipleFormsAction`; an older `ApiSubmitApplicationFormAction`
 * is also defined) to `/api/non-user-graphql?op=<operation>`; its variables
 * carry the token (`UNIVERSAL_ENT===…`, or `recaptcha_dummy_token` without a
 * site key). Ashby checks required fields on its server only. Its answer is
 * `FormSubmitSuccess`, or `FormRender` with `errorMessages` and `formErrors`
 * (`{ message, fieldEntryId }`), plus an optional application-limit block
 * message; a reCAPTCHA score rejection is a GraphQL error whose
 * `extensions.ashbyErrorType` is `RECAPTCHA_SCORE_BELOW_THRESHOLD`.
 *
 * Privacy: request bodies and responses are read in memory only to derive the
 * fields below (operation names, HTTP statuses, the token's kind, the result
 * type, Ashby's error codes and messages, field-error ids) and are never kept,
 * logged, or returned.
 */

export const ASHBY_SUBMIT_OPERATIONS: ReadonlySet<string> = new Set([
  "ApiSubmitSingleApplicationFormAction",
  "ApiSubmitMultipleFormsAction",
  "ApiSubmitApplicationFormAction"
]);

/** Ashby's error type for a submit its reCAPTCHA Enterprise score check refused. */
export const ASHBY_RECAPTCHA_REJECTED = "RECAPTCHA_SCORE_BELOW_THRESHOLD";

export const ASHBY_ACCEPTED_CONFIRMATION = "Ashby's server accepted the application: its answer to the submit was FormSubmitSuccess.";

export const ASHBY_BLOCKED_MESSAGE =
  "Ashby answered the submit with its application-limit block message, so the application was not taken as a normal submission. The run is not marked submitted; check the application on the site before retrying.";

/** No page text: this message reaches the pipeline's notices. */
export function ashbyFormErrorsMessage(count: number): string {
  return `Ashby's server refused the submission and named ${count} field(s) to correct, so nothing was taken. The run waits for your answers with the approval withdrawn; it is not marked submitted.`;
}

export type AshbyNetworkCall = { operation: string; status: number | null; failed: boolean; clicks: number };
export type AshbyTokenKind = "present" | "dummy" | "missing" | "unknown";
export type AshbySubmitCall = AshbyNetworkCall & {
  recaptchaToken: AshbyTokenKind;
  resultType: string | null;
  success: boolean;
  errorCodes: string[];
  errorMessages: string[];
  formErrorMessages: string[];
  fieldErrors: Array<{ fieldEntryId: string | null; message: string }>;
  blockMessage: boolean;
};
export type AshbySubmitNetwork = {
  /** Every Ashby GraphQL call since the watch started (answer saves and submits), at most 40. */
  calls: AshbyNetworkCall[];
  /** Submit mutations, at most 5. */
  submits: AshbySubmitCall[];
  /** reCAPTCHA token (reload) requests since the watch started. */
  recaptchaTokenRequests: number;
  /** Their HTTP statuses (null: no answer yet or failed), at most 5. */
  recaptchaTokenStatuses: Array<number | null>;
};
export type AshbyNetworkVerdict = "none" | "accepted" | "recaptcha-rejected" | "form-errors" | "blocked";

const MAX_CALLS = 40;
const MAX_SUBMITS = 5;
const MAX_TOKEN_STATUSES = 5;
const MAX_LIST = 10;
const MAX_MESSAGE = 200;
const MAX_BODY = 2_000_000;
const OPERATION = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const RESULT_TYPE = /^[A-Za-z]{1,80}$/;
const FIELD_ENTRY_ID = /^[A-Za-z0-9_-]{1,200}$/;
const RECAPTCHA_HOSTS = new Set(["recaptcha.net", "www.recaptcha.net", "google.com", "www.google.com"]);

/** The `op` of an Ashby GraphQL request (`*.ashbyhq.com/api/non-user-graphql?op=…`); null for any other URL. */
export function ashbyGraphqlOperation(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "ashbyhq.com" && !host.endsWith(".ashbyhq.com")) return null;
    if (parsed.pathname !== "/api/non-user-graphql") return null;
    const op = parsed.searchParams.get("op");
    return op !== null && OPERATION.test(op) ? op : null;
  } catch {
    return null;
  }
}

/** A reCAPTCHA token request (`/recaptcha/enterprise/reload` or `/recaptcha/api2/reload` on recaptcha.net or google.com). */
export function isRecaptchaTokenRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return RECAPTCHA_HOSTS.has(parsed.hostname.toLowerCase()) && /^\/recaptcha\/(?:enterprise|api2)\/reload$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The kind of reCAPTCHA token a submit body carries; only the label leaves this function. */
export function readAshbySubmitToken(postData: string | null): AshbyTokenKind {
  if (postData === null) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    return "unknown";
  }
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(body)) return "unknown";
  const variables = body.variables;
  const token = isRecord(variables) ? variables.recaptchaToken : undefined;
  if (typeof token !== "string" || !token.trim()) return "missing";
  if (token.includes("recaptcha_dummy_token")) return "dummy";
  return "present";
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);

const pushDistinct = (list: string[], value: string): void => {
  if (value && list.length < MAX_LIST && !list.includes(value)) list.push(value);
};

type SubmitAnswer = Pick<AshbySubmitCall, "resultType" | "success" | "errorCodes" | "errorMessages" | "formErrorMessages" | "fieldErrors" | "blockMessage">;

const EMPTY_ANSWER = (): SubmitAnswer => ({
  resultType: null,
  success: false,
  errorCodes: [],
  errorMessages: [],
  formErrorMessages: [],
  fieldErrors: [],
  blockMessage: false
});

/**
 * What Ashby answered to a submit: the result type, whether it was a clean
 * FormSubmitSuccess, Ashby's error codes and messages, the FormRender errors,
 * and whether the application-limit block message came back. Nothing else is
 * copied (no field values, no ids other than a field-entry id, no HTML).
 */
export function readAshbySubmitResponse(status: number, bodyText: string | null): SubmitAnswer {
  const answer = EMPTY_ANSWER();
  if (bodyText === null || bodyText.length > MAX_BODY) return answer;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return answer;
  }
  if (!isRecord(parsed)) return answer;
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const error of errors) {
    if (!isRecord(error)) continue;
    const extensions = isRecord(error.extensions) ? error.extensions : {};
    const code = extensions.ashbyErrorType;
    if (typeof code === "string" && ERROR_CODE.test(code)) pushDistinct(answer.errorCodes, code);
    const message = typeof extensions.message === "string" ? extensions.message : typeof error.message === "string" ? error.message : null;
    if (message !== null) pushDistinct(answer.errorMessages, collapse(message));
  }
  const data = isRecord(parsed.data) ? parsed.data : {};
  const rawAction = data.submitApplicationFormAction ?? data.submitSingleApplicationFormAction ?? data.submitMultipleFormsAction;
  const action = isRecord(rawAction) ? rawAction : {};
  const result = isRecord(action.applicationFormResult) ? action.applicationFormResult : null;
  const typeName = result?.__typename;
  answer.resultType = typeof typeName === "string" && RESULT_TYPE.test(typeName) ? typeName : null;
  const surveys = Array.isArray(action.surveyFormResults) ? action.surveyFormResults : [];
  const renders = [result, ...surveys].filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.__typename === "FormRender");
  for (const render of renders) {
    if (Array.isArray(render.errorMessages)) {
      for (const message of render.errorMessages) if (typeof message === "string") pushDistinct(answer.formErrorMessages, collapse(message));
    }
    if (Array.isArray(render.formErrors)) {
      for (const formError of render.formErrors) {
        if (!isRecord(formError) || answer.fieldErrors.length >= MAX_LIST) continue;
        const id = formError.fieldEntryId;
        answer.fieldErrors.push({
          fieldEntryId: typeof id === "string" && FIELD_ENTRY_ID.test(id) ? id : null,
          message: typeof formError.message === "string" ? collapse(formError.message) : ""
        });
      }
    }
  }
  const messages = isRecord(action.messages) ? action.messages : {};
  const block = messages.blockMessageForCandidateHtml;
  answer.blockMessage = typeof block === "string" && block.trim() !== "";
  answer.success = status >= 200 && status < 300
    && answer.resultType === "FormSubmitSuccess"
    && surveys.every((entry) => isRecord(entry) && entry.__typename === "FormSubmitSuccess")
    && errors.length === 0
    && !answer.blockMessage;
  return answer;
}

/** What Ashby's answer to the submit means; "none" when no submit was answered with something recognized. */
export function ashbyNetworkVerdict(network: AshbySubmitNetwork | null): AshbyNetworkVerdict {
  if (!network) return "none";
  const answered = network.submits.filter((submit) => submit.status !== null);
  if (answered.some((submit) => submit.errorCodes.includes(ASHBY_RECAPTCHA_REJECTED))) return "recaptcha-rejected";
  const last = answered[answered.length - 1];
  if (!last) return "none";
  if (last.success) return "accepted";
  if (last.blockMessage) return "blocked";
  if (last.resultType === "FormRender" && (last.fieldErrors.length > 0 || last.formErrorMessages.length > 0)) return "form-errors";
  return "none";
}

/** True when a submit request went out after the latest click (`clicks` = clicks made so far). */
export function ashbySubmitSentAfter(network: AshbySubmitNetwork | null, clicks: number): boolean {
  return Boolean(network?.submits.some((submit) => submit.clicks >= clicks));
}

/** The fields Ashby's last answered submit named, as invalid fields (no labels: Ashby names them by field-entry id). */
export function ashbyNetworkInvalidFields(network: AshbySubmitNetwork | null): InvalidField[] {
  if (!network) return [];
  const answered = network.submits.filter((submit) => submit.status !== null);
  const last = answered[answered.length - 1];
  if (!last) return [];
  const fields: InvalidField[] = last.fieldErrors.map((error) => ({ ref: error.fieldEntryId, label: "", error: error.message }));
  const named = new Set(last.fieldErrors.map((error) => error.message));
  for (const message of last.formErrorMessages) {
    if (!named.has(message)) fields.push({ ref: null, label: "", error: message });
  }
  return fields.slice(0, 30);
}

export type AshbyNetworkRecorder = {
  noteClick(): void;
  cancelClick(): void;
  request(id: object, url: string, postData: () => string | null): void;
  response(id: object, status: number, body: () => Promise<string>): void;
  failed(id: object): void;
  snapshot(waitMs?: number): Promise<AshbySubmitNetwork>;
};

type EntryIndexes = { calls?: number; submit?: number; token?: number };

/**
 * Records Ashby's GraphQL calls and reCAPTCHA token requests from the page's
 * network events. A submit's body is read once, only for its token's kind; a
 * submit's answer is read only for the fields readAshbySubmitResponse keeps.
 * Never throws.
 */
export function createAshbyNetworkRecorder(): AshbyNetworkRecorder {
  let clicks = 0;
  const calls: AshbyNetworkCall[] = [];
  const submits: AshbySubmitCall[] = [];
  let recaptchaTokenRequests = 0;
  const recaptchaTokenStatuses: Array<number | null> = [];
  // Playwright Request objects live as long as the page; a WeakMap never keeps one alive.
  const entries = new WeakMap<object, EntryIndexes>();
  const inflight = new Set<Promise<void>>();
  return {
    noteClick: () => {
      try {
        clicks += 1;
      } catch {
        // never throws
      }
    },
    cancelClick: () => {
      try {
        clicks = Math.max(0, clicks - 1);
      } catch {
        // never throws
      }
    },
    request: (id, url, postData) => {
      try {
        if (isRecaptchaTokenRequest(url)) {
          recaptchaTokenRequests += 1;
          if (recaptchaTokenStatuses.length < MAX_TOKEN_STATUSES) {
            recaptchaTokenStatuses.push(null);
            entries.set(id, { token: recaptchaTokenStatuses.length - 1 });
          }
          return;
        }
        const operation = ashbyGraphqlOperation(url);
        if (operation === null) return;
        const indexes: EntryIndexes = {};
        if (calls.length < MAX_CALLS) {
          calls.push({ operation, status: null, failed: false, clicks });
          indexes.calls = calls.length - 1;
        }
        if (ASHBY_SUBMIT_OPERATIONS.has(operation) && submits.length < MAX_SUBMITS) {
          let token: AshbyTokenKind = "unknown";
          try {
            token = readAshbySubmitToken(postData());
          } catch {
            token = "unknown";
          }
          submits.push({ operation, status: null, failed: false, clicks, recaptchaToken: token, ...EMPTY_ANSWER() });
          indexes.submit = submits.length - 1;
        }
        entries.set(id, indexes);
      } catch {
        // never throws
      }
    },
    response: (id, status, body) => {
      try {
        const indexes = entries.get(id);
        if (!indexes) return;
        if (indexes.token !== undefined) recaptchaTokenStatuses[indexes.token] = status;
        if (indexes.calls !== undefined) calls[indexes.calls]!.status = status;
        if (indexes.submit !== undefined) {
          const submit = submits[indexes.submit]!;
          submit.status = status;
          let reading: Promise<string>;
          try {
            reading = body();
          } catch (error) {
            reading = Promise.reject(error);
          }
          const read: Promise<void> = reading
            .then((text) => readAshbySubmitResponse(status, text), () => readAshbySubmitResponse(status, null))
            .then((answer) => {
              Object.assign(submit, answer);
            })
            .catch(() => undefined)
            .finally(() => {
              inflight.delete(read);
            });
          inflight.add(read);
        }
      } catch {
        // never throws
      }
    },
    failed: (id) => {
      try {
        const indexes = entries.get(id);
        if (!indexes) return;
        if (indexes.calls !== undefined) calls[indexes.calls]!.failed = true;
        if (indexes.submit !== undefined) submits[indexes.submit]!.failed = true;
      } catch {
        // never throws
      }
    },
    snapshot: async (waitMs = 2_000) => {
      try {
        if (waitMs > 0 && inflight.size > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled([...inflight]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, waitMs);
            })
          ]);
          if (timer !== undefined) clearTimeout(timer);
        }
        return {
          calls: calls.map((call) => ({ ...call })),
          submits: submits.map((submit) => ({
            ...submit,
            errorCodes: [...submit.errorCodes],
            errorMessages: [...submit.errorMessages],
            formErrorMessages: [...submit.formErrorMessages],
            fieldErrors: submit.fieldErrors.map((error) => ({ ...error }))
          })),
          recaptchaTokenRequests,
          recaptchaTokenStatuses: [...recaptchaTokenStatuses]
        };
      } catch {
        return { calls: [], submits: [], recaptchaTokenRequests: 0, recaptchaTokenStatuses: [] };
      }
    }
  };
}
