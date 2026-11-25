# Uploads labelled through their wrapping label read unlabeled

Found in pass 16 (2026-11-25) on Rippling applications (Forterra run <run id>
and APEX Analytix run <run id>, ats.rippling.com): the uploads `ia-control-1`
to `ia-control-3` were skipped as "Optional upload left empty", so the resume
was never attached, and the phone-country popover's "Search" box (field-38)
paused as a required question. The 2026-11-20 capture note in
`bugs/resolved/rippling-application-pages-were-not-recognized.md` records
that Rippling's uploads sit inside `label[aria-labelledby]`; the collector
read the wrapping label's own text ("Upload") but never its
`aria-labelledby`. Fix: a wrapping label's `aria-labelledby` text labels its
control first, and a list's own box labelled only "Search" is skipped
(`isListSearchBox`). Regressions: `pnpm test:browser:unrecognized-forms`
(fixtures/labelledby-application.html, derived from the capture note) and the
Track 35 cases in `pnpm test:browser-worker:fast`.
