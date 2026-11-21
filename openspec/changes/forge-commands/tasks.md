# forge-commands — tasks

> Status: PROPOSED — awaiting owner review (proposal Authorization
> note). Do not check off until apply is approved.

## 1. Commands

- [ ] 1.1 `/forge sync` — execute-type template (invoke forge_sync
  NOW, report the diff) + registration in both v1 config and v2
  command domains + family guard.
- [ ] 1.2 `/forge init` — in-band project-recipe drafting flow
  (pool namespace, roles, shapes; interview or project context),
  refuse-if-exists with review offer.
- [ ] 1.3 `/forge init global` — same flow for the global forge.json,
  scaffold ships commented General/Explore override entries
  (builtin-override content).
- [ ] 1.4 Unconfigured-crew refusal text: name the levers alongside
  the in-band ask.

## 2. Tests + docs

- [ ] 2.1 Test matrix: command registration both domains, argument
  routing (sync / init / init global / unknown), family guard,
  refuse-if-exists, template content assertions.
- [ ] 2.2 README: command table gains the /forge family; the "no
  /forge command family" note is replaced by the family inventory.

## 3. Gate + release

- [ ] 3.1 Full gate (typecheck, suite, validate, bundle) + sandbox
  E2E (init round-trip, force sync, refuse-if-exists); version bump +
  npm publish only after owner approval.
