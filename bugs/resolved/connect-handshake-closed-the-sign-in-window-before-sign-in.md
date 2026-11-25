# Connect Handshake closed the sign-in window before sign-in

A signed-out visit to `https://app.joinhandshake.com/login` redirects to
`/access`, Handshake's sign-in page. `classifyHandshakeUrl` read any app path
outside its sign-in list as signed in, so `/access` counted as "connected":
the agent closed the window about a second after it opened and recorded a
false "connected" status. Runs could also have treated the sign-in page as a
signed-in page. Reported by the candidate and reproduced with a throwaway
browser on 2026-09-22.

Fixed: `/access` is a sign-in path, and the agent no longer closes the window
on its own before a 10-minute timeout; the candidate closes it and the last
Handshake page seen decides the status. Regressions: the `/access` cases in
`testing-harness/browser-worker/handshake-session.test.ts` and the Connect
Handshake window tests in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.
