# List boxes on unrecognized sites were read as text boxes

Found in pass 16 (2026-11-25) on Lockheed Martin's Eightfold application
(run <run id>, lockheedmartin.eightfold.ai). Every dropdown question (ids
`input-7` to `input-67`) was recorded as kind "text" with no options, so the
work authorization, sponsorship, previous employment, and security clearance
questions paused as "How should … be answered?" although the saved answers
resolve them: a type-ahead with no options took only a saved text answer,
never a Yes/No one. The pronoun box timed out ("did not respond in time")
because it is readonly, and the how-heard box typed the saved answer and
found no matching suggestion. Cause: Eightfold draws its lists with the
public Octuple Select, an `input role="combobox"` naming a listbox that exists
only while open, and the collector read such an input as a type-ahead without
opening it. Fix: a bare ARIA combobox input is opened once while the form is
read and its listbox's options are read (`readAriaListOptions`); a readonly
one becomes a plain list chosen by clicking its option and kept when the input
shows it (or its dialing code), an editable one a searched list keeping its
options, and a searched list types the option the site shows for a saved
answer. The phone "Country code picker" takes the profile country. No live
check was allowed: the Eightfold markup is derived from Octuple's source and
the recorded field shapes, and the next real run confirms it. Regressions:
`pnpm test:browser:unrecognized-forms` (fixtures/aria-list-application.html),
the Track 35 cases in `pnpm test:browser-worker:fast`, and the unrecognized
site run in `pnpm test:browser-worker:local`.
