# Workday dropdowns were read from the previous field's closing list

Found 2026-11-25 on the real workspace, in the same pass. "Phone Device
Type" paused on rockwellautomation.wd1 (<run id>, <run id>),
highmarkhealth.wd1 (<run id>) and micron.wd1 (<run id>) with options that
were the Country Phone Code field's picked item followed by the Country or
State list, so the profile's saved phone type (the basis all along) was
"not one of its options"; littelfuse.wd1 chose it. Cause: after clicking a
dropdown, `collectControls` waited for any visible `role="option"` inside a
`role="listbox"`, which the picked chip (drawn as an option in a listbox)
satisfied at once, and read every visible option on the page: the chip and
the list of the dropdown read just before, still on screen while it closed.
The adapter now closes an open list and waits for it to go, reads only the
list the button names in `aria-controls` (else the open
`activeListContainer`, else a visible listbox outside other fields and
picked items), waits until its options stop changing, and picks the option
inside that list; history dropdowns (degree) use the same reader.
Regression: the `?widgets=real` scenario of
`testing-harness/browser/fixture-run.ts` (`xvfb-run -a pnpm
test:browser:fixture`): portal lists 400 ms after the click, closed lists
lingering 300 ms, chips with option roles; the old code paused on Phone
Device Type and State. Not verified live: the real tenants' list markup
(no form-step DOM was captured); a tenant that names the phone type other
than "Mobile" still pauses.
