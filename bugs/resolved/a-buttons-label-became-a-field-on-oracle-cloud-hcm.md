# A button's label became a field on Oracle Cloud HCM

Corvane's Oracle run (<run id>) held on "Discard": button and reset inputs
were read as fields, and a button's inner label span (Oracle JET's
`oj-button-label`) could label an unlabeled control beside it. Now button and
reset inputs and controls with a button, link, menu item, or tab role are not
fields, text inside a button or link never labels a control, and an
unknown-kind control labelled only with an action word ("Discard", "Back",
"Next", "Submit"…) is dropped. Regressions: `recognition-planner.test.ts` and
the Oracle email-step scenario of `pnpm test:browser:greenhouse`
(`fixtures/oracle-apply-email.html`, derived, not captured).
