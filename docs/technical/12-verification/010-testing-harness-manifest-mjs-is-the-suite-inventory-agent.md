`testing-harness/manifest.mjs` is the suite inventory.
`agent:doctor` validates commands and prerequisites.
`agent:verify` maps changed paths to features.
`agent:finish` is the final gate.
`agent:finish` and the browser-tier suites the harness runner starts first take one of the machine-wide gate slots (`INTERNSHIP_AGENT_GATE_SLOTS`, default 2) described in `015-heavy-gates-take-a-machine-wide-slot.md`.
