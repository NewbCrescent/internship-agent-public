/**
 * Sign-in detection for the candidate's own Handshake browser profile. It
 * reads only the page URL's host and path, never page content, cookies, or
 * query values, and never touches credentials: the candidate signs in by hand
 * in a visible window.
 *
 * The sign-in path list is partly observed (a signed-out `/login` redirects to
 * `/access`) and partly a best-effort reading of Handshake's URLs; it has not
 * been checked against a signed-in account. Pages off Handshake classify as
 * `other`, which callers treat as "unknown" rather than "connected".
 */
export const HANDSHAKE_LOGIN_URL = "https://app.joinhandshake.com/login";

export type HandshakeUrlState = "signed_out" | "connected" | "other";

// `/access` is where a signed-out `/login` lands (observed live 2026-09-22).
const SIGNED_OUT_PATH = /^\/(?:access|login|log_in|sign_in|signin|sign_up|signup|users\/sign_in|users\/sign_up|logout|sso|saml|auth)(?:\/|$)/i;

export function isHandshakeHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase("en-US");
  return host === "joinhandshake.com" || host.endsWith(".joinhandshake.com");
}

export function classifyHandshakeUrl(url: string): HandshakeUrlState {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (parsed.protocol !== "https:" || !isHandshakeHost(parsed.hostname)) return "other";
  // The marketing site is public whether or not the candidate is signed in.
  const host = parsed.hostname.toLocaleLowerCase("en-US");
  if (host === "joinhandshake.com" || host === "www.joinhandshake.com") return "other";
  if (SIGNED_OUT_PATH.test(parsed.pathname)) return "signed_out";
  return "connected";
}

/** Real runs open a visible window unless HEADLESS=1 is set explicitly. */
export function shouldRunHeadless(env: Record<string, string | undefined> = process.env): boolean {
  return env.HEADLESS === "1";
}
