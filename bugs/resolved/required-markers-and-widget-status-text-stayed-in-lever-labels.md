# Required markers and widget status text stayed in Lever labels

Threadline Studio's Lever run (<run id>) held on "Full name✱", "Phone ✱",
"Current location ✱No location found. Try entering a different
locationLoading", and a data-retention consent checkbox. Labels kept "✱" (only
a trailing `*` was stripped) and the whole wrapping label's text, including the
location widget's hidden status texts. Now required markers (`*`, `∗`, `✱`,
`＊`, "(required)") are stripped and mark the field required, label text skips
controls, live regions, status widgets, and hidden elements, a wrapping label
uses its own label element, "Full name", "Phone", and "Current location" map to
the profile, and a consent checkbox always pauses with "consent checkbox:
needs your OK". Regressions: `recognition-planner.test.ts` and the Lever
scenario of `pnpm test:browser:greenhouse` (`fixtures/lever-application.html`,
derived from Lever's public form markup).
