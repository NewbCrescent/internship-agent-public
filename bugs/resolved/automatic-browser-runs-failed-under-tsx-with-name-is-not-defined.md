# Automatic browser runs failed under tsx with "__name is not defined"

The first `pnpm pipeline:run` with auto-apply on 2026-09-23 stopped all 107
automatic runs before filling anything: `collectControlsIn` threw
`ReferenceError: __name is not defined` inside the page. tsx compiles with
esbuild keepNames, which wraps inner functions in an `__name` helper that
does not exist in the page when the function is passed to `evaluate()`.
Dashboard-started runs (Next's compiler) were unaffected, and the fixture
run hid the defect by installing its own page shim. Each failure was also
recorded as a one-time stop, so the pipeline would never have retried them.

Fixed: `createPlaywrightPage` installs a string no-op `__name` in the page,
now and on every navigation, before any evaluate. Only real stops (sign-in,
no form) are recorded once as "Automatic browser run needs you"; other
failures are logged as "Automatic browser run failed" and retried, so the
107 earlier markers no longer block. Regressions: the fixture run without a
test shim (it failed with the same error before the fix) and `retries an
unexpected failure on the next pass` in
`testing-harness/browser-worker/run-lifecycle.integration.test.ts`.
