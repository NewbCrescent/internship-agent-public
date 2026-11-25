# Quick apply check raced Handshake's rendering

`openApplicationDialog` counted "Quick apply" buttons right after the page's
load event, but Handshake renders them later. The Example Co run's start step
found the button; its submit step, on 2026-09-22, did not and stopped with
"This Handshake posting shows no Quick apply button" before clicking
anything (the run stayed awaiting approval). The fixture reproduction also
showed that, without a dialog scope, the submit helper could click a submit
button inside a hidden dialog.

Fixed: the adapter waits up to 15 seconds for a visible Quick apply button,
and the submit helper ignores hidden or disabled controls. Regression: the
Handshake-style fixture renders its Quick apply buttons 1.2 seconds after
load and checks that a hidden dialog's submit is refused.
