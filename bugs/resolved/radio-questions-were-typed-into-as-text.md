# Radio questions were typed into as text

Cloudrise's Lever run stopped with `locator.fill: Error: Input of type "radio"
cannot be filled` on "Non Applicable I am a national of a Member State of the
European Union…". The generic reader read each radio as its own field labelled
by its option, and the planner returned a fill for a remembered answer. Now
radios sharing a name are one choice question with their options, answered by
checking the radio whose label equals the option, the planner never fills a
radio, checkbox, list, or upload (it pauses), and the executor refuses to type
into one. Regressions: `recognition-planner.test.ts` and the Lever scenario of
`pnpm test:browser:greenhouse`.
