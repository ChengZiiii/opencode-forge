# forge-commands — design

## Decisions

- **D1 — One command, argument-routed** (the /plan precedent): a
  single `/forge` execute-type command routes on `$ARGUMENTS`:
  `sync` → force-sync template; `init` → project scaffold flow;
  `init global` → global scaffold flow (ships the commented
  `override` node — builtin-override D6); empty/unknown → a short
  help listing the three forms. Registered through the existing
  `addTemplateCommand` helper (plugin.ts) in BOTH v1 config and v2
  command domains.
- **D2 — Templates instruct, never write:** every form is a prompt
  template for the forge agent. `/forge sync` = "invoke the
  forge_sync tool NOW and paste its diff verbatim". `/forge init` =
  interview-or-context drafting of the workspace forge.json (pool
  namespace, roles, shapes) with the refuse-if-exists guard (exists →
  review, never overwrite). `/forge init global` = same for the
  global forge.json. All effects land in the transcript via tools.
- **D3 — Family guard:** step-0 identical to /plan /goal /crew (no
  forge-family tool in hand → stop and point the user at the forge
  agent).
- **D4 — Net teaches levers:** the unconfigured-crew refusal's
  guidance block gains one line naming `/forge init` and
  `/forge init global` alongside the in-band ask. Gate semantics
  otherwise untouched.
- **D5 — No automation change:** `/forge sync` is a manual lever;
  staleness gate + in-band recovery and `sync:"auto"` behave exactly
  as shipped in 0.30.0.

## Test plan

Command registration in both domains; argument routing matrix
(sync / init / init global / empty / unknown); family-guard text;
refuse-if-exists guard text; template content assertions (sync names
the tool; init names the recipe path; init global names the override
node); crew refusal mentions the levers. README: command table gains
the `/forge` family; the "no /forge command family" note is replaced.
Suite baseline stays green; typecheck; bundle.
