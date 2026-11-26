# The automatic submit click went to a hidden cookie banner button

On run <run id> (2026-11-25) the generic submit click on MITRE's Phenom step 1 resolved to Osano's cookie banner "Accept" and timed out after 30 s waiting for it to be visible.
No control said submit or apply, so the last resort took the first control whose type read as submit, and a `<button>` with no type attribute reports "submit"; the banner's typeless Accept came first in the page.
The banner had already been denied and was hidden with its box kept, and only boxless controls were skipped, so the hidden Accept still counted; that it was hidden is the only reason it was not clicked.
Without the banner the last resort would have clicked the step's explicit-submit "Next".
Fix: `findSubmitIndex` (`packages/browser/src/handshake-executor.ts`) never counts a hidden, cookie-consent, accept-only, or step control, and its last resort is an explicit `type="submit"` attribute only.
Before every generic submit click the run is held, with the approval withdrawn and nothing clicked, when the page still shows a "Next" and no submit control, or when no submit control of the form's own is found (`submitTargetHoldReason`, `packages/browser/src/submit-gate.ts`).
Regressions: scenario (i) of `pnpm test:browser:unrecognized-forms` (banner shown, dismissed, and absent) and the pre-click hold cases in `pnpm test:browser-worker:local`.
