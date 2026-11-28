# Newsletter and subscribe boxes on careers pages were read as the application form

Found 2026-11-27 in Track 77's triage of the "The application site type was not recognized automatically" blocker (b096af2a79d), on the real workspace.
Amperity's run <run id> (`amperity.com/careers?gh_jid=8393990#openpositions`) and Lucid Motors' run <run id> (`lucidmotors.com/careers/search/5290941007?gh_jid=5290941007`) were awaiting approval as unknown sites holding only a newsletter email.
Amperity's only decisions were `footer-form-website` (skipped) and `footer-form-email` (filled): its footer newsletter form ("Sign up for monthly updates", `div.styles_newsletter_signup_form__…` > form with a "website" honeypot and "Work Email").
Lucid's only decision was `email` (filled): its Subscribe block (`div#subscribe` … `div.SubscribeForm_formBodyWrapper__…` > `input#email`).
Because a field was read, the run counted the page as the application form, so neither the posting's Apply entry nor its Greenhouse embed was followed, and approving either run would have submitted a newsletter signup.
Fix: `collectControlsIn` (`packages/browser/src/handshake-executor.ts`) never reads a control whose six nearest ancestors include a container whose id or class names a newsletter, subscription, mailing list, job alert, or talent community or network, when that container holds no file upload and at most four controls a person fills; the page then has no application field and `followApplyEntry` and the site walker go on to the Greenhouse embed.
Same family: `an-icims-career-sites-newsletter-box-was-read-as-the-application-form.md` (Track 69, Harvard, iCIMS's third-party newsletter `email-<form id>`) is fixed there by `icimsPostingPage`; this container rule is the general guard for sites other than iCIMS.
Amperity also draws Greenhouse's embed only after cookies are accepted; that half is `greenhouse-applications-that-careers-pages-draw-only-after-cookies-are-accepted-were-never-reached.md`.
Regression: the newsletter scenario in `testing-harness/browser/site-navigation-run.ts` (`xvfb-run -a pnpm test:browser:site-navigation`; fixtures `newsletter-footer-posting.html`, served with a gh_jid and Greenhouse's embed script, and the negative control `subscription-application.html`).
fixture: captured 2026-11-27 (reduced from read-only fetches of both pages)

## Refuted causes

- Lucid's Greenhouse embed failed to load. Evidence: Lucid's page-10799ea6538e7a06.js loads the embed script (`boards.greenhouse.io/embed/job_board/js?for=lucidmotors`) unconditionally; run <run id>'s only decision is the Subscribe box's `email`.
