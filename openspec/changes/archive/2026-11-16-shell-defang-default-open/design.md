# Design: shell-defang-default-open

## Context

Fold A (dispatch-resilience, archived) built: a config-hook posture rewrite
(unconfigured → plugin-injected `ask`), a pre-rewrite snapshot honoring
explicit user values, and a headless classifier (READ runs / WRITE refuses)
resolving the injected ask on serve hosts. First real-world boot after the
user's restart refused the plugin's own `git push` — the default was
fail-closed for everyone, which the product owner rejects: the default must
be omo-style default-open; hang prevention belongs in the executor.

## Approach

**Posture pass-through (config hook + belt).** Today the hook unconditionally
injects `permission.forge_shell = "ask"` after snapshotting explicit user
values. The change: when the snapshot records NO explicit user value, inject
NOTHING (the key is absent → the host's `"*": allow` fallback applies), and
the permission.ask belt drops the headless classifier call site entirely —
every posture reaches the host unmodified. Explicit allow skips the ask;
explicit deny refuses; explicit ask asks (TUI dialog / run auto-reject /
serve pending — all the HOST's semantics, exactly like the native shell
tool). The snapshot's classification (unconfigured / allow / deny / ask)
now only decides whether the plugin touches anything at all: unconfigured →
untouched.

**Classifier retirement (full omo parity — product owner's call).** The
opt-in variant (classifier lives only for explicit-`ask` users) was designed
first and REJECTED in review: the owner ruled "make it like omo, direct
pass-through". Consequence accepted and disclosed: an explicit `ask` on a
serve host is a pending ask with no plugin-side rescue — same as the native
bash tool in the same spot; the host owns that behavior. `FORGE_HEADLESS`
and the plugin's headless detection on the posture path are removed with the
classifier. `src/exec-classify.ts` SURVIVES: the readonly-exec-seal (kept by
product decision, now the ONLY plugin-side exec refusal) still uses the same
classifier to recognize write-class commands for explicit-readonly workers —
the file loses one call site, not its reason to exist.

**Hygiene at spawn, not string mutation (omo port, improved).** omo prepends
`GIT_EDITOR=: …` to git command strings because they hook the host's native
bash tool and can only mutate args. forge owns the `forge_shell` executor and
spawns through `src/proc.ts` `shellSpawn` (which already merges env), so the
defang lands in the spawn env block: `GIT_EDITOR=:`, `EDITOR=:`,
`GIT_PAGER=cat`, `PAGER=cat`, `GIT_MERGE_AUTOEDIT=no`, merged under (never
overriding) the caller's own env. Universal (not git-scoped): the spawn-env
channel costs nothing per command, covers non-git editors/pagers too, and
keeps the command string byte-identical to what the model issued (audit
faithfulness). Risk: a command that legitimately wants an interactive editor
gets `:` instead — in an agent context that command was going to hang
anyway; accepted and disclosed.

**Known-interactive warning (omo parity).** An enumerated pattern list
(logins: `npm login`, `docker login`, `gh auth login`…; manual installers;
full-screen TUIs) checked against the command head. Match → prepend a
`[forge:interactive] '<pattern>' may prompt interactively…` warning line to
the tool result. Never blocks — the permission posture is the only refuser.

**Seal untouched.** readonly-exec-seal stays posture-independent (it gates
readonly workers' write-class commands regardless of permission posture) and
still lands before any headless classification. The classifier itself
(`src/exec-classify.ts`) is reused as-is — only its call site narrows.

## Alternatives rejected

- **Keep the classifier as opt-in** (the original design of this change):
  preserved honest headless resolution for explicit-`ask` users, but the
  product owner rejected it in review — full omo parity wins, the classifier
  dies on the posture path (the seal keeps the file).
- **Default-inject `allow` instead of injecting nothing**: looks equivalent
  but writes a permission rule the user never expressed, defeating future
  host-level defaults (e.g. if the host changes its fallback or the user sets
  a scoped deny elsewhere). Injecting nothing is the honest "not ours".
- **Command-string mutation (omo-faithful)**: audit-unfaithful (the executed
  string ≠ the issued string) and shell-quoted-fragile on Windows; spawn-env
  is strictly better on a surface we own.

## Risks

- Default-open means the bypass surface is now "everything" for unconfigured
  users — that IS the product decision (README discloses it; the readonly
  seal still covers the readonly-worker shape).
- Explicit `ask` + serve host = a pending ask with no plugin-side rescue
  (host semantics, same as native bash) — accepted omo parity; the README
  will say "if you want confirmation, run a TUI; if you run serve, answer
  asks via the host API or don't configure ask".
- Tests that asserted the injected-ask default and the headless denial
  (fold A wiring suite) get rewritten or retired to the pass-through
  contract — the behavioral change is exactly those assertions.
- The snapshot must distinguish unconfigured from explicit values robustly
  (the pre-rewrite config object carries the user's raw value; a plugin
  re-presentation must not be mistaken for a user value — the existing
  snapshot discipline already covers this; tests pin it).
