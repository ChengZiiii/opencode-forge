# tool-partition Delta — readonly-exec-seal

## ADDED Requirements

### Requirement: Readonly workers execute on a sealed supervised-exec channel

For any session whose running `forge-*` agent has an effective readonly shape (an EXPLICIT `shape: "readonly"`; an absent shape defaults to write and is NOT sealed), the plugin SHALL gate the supervised exec channel (`forge_shell`) for that session: commands classified READ-CLASS (inspection and search — e.g. directory listings, file reads, `rg`/`grep`, `git log`/`git status`/`git diff`, version and help queries, read-only `node`/`python` evals) SHALL flow normally; commands classified WRITE-CLASS SHALL be denied with a bounded finding that names the readonly shape, names the classified write indicator, and points at the remedy (`shape: "write"` on that agent when its job legitimately mutates). Write-class indicators SHALL cover at minimum: output redirection to files (`>` `>>` and their PowerShell equivalents), the known mutating cmdlets and commands (`Set-Content`, `Out-File`, `New-Item` with a file/item type, `Remove-Item`, `Move-Item`, `Copy-Item` writing, `Add-Content`, `Clear-Content`, `Start-Process`-spawning-writers is NOT covered — indirection stays out of scope), `git` mutating subcommands (`add`, `commit`, `push`, `reset`, `checkout`, `rebase`, `merge`, `clean`, `rm`), package-manager publishes/installs mutating the tree (`npm publish`, `npm install`, `bun add`, `pip install`), and any command whose parsed targets write INSIDE the session workspace by explicit path argument. The classification SHALL be a pure, injectable function (unit-tested, no fs access at classify time) evaluated on the command string BEFORE spawn; a command that fails to classify SHALL be treated as READ-CLASS (fail-open on the channel — the seal is belt-in-depth on top of the tool-face deny, not a sandbox, and the README SHALL disclose the covered indicators and the known bypass surface verbatim). The seal SHALL compose with, not replace, the existing draft-phase write posture: draft-period ask/deny semantics on the channel are unchanged; a write-shaped worker is never sealed; the primary forge session is never sealed.

#### Scenario: Read-class commands flow for an explicit readonly worker

- **WHEN** a session runs `forge-reviewer` with explicit `shape: "readonly"` and its dispatch calls `forge_shell` with `rg TODO src/` or `git log --oneline -10`
- **THEN** the command executes normally and no seal finding is recorded

#### Scenario: A redirect is denied with the shape named

- **WHEN** an explicit readonly worker's `forge_shell` call carries `node build.js > out.txt`
- **THEN** the spawn is denied, and the bounded finding names the readonly shape, the redirect indicator, and the `shape: "write"` remedy — the worker is told to report the refusal verbatim, not work around it

#### Scenario: A mutating cmdlet is denied

- **WHEN** an explicit readonly worker's `forge_shell` call carries `Set-Content -Path notes.md -Value x`
- **THEN** the spawn is denied with the same finding shape (mutating-cmdlet indicator)

#### Scenario: A workspace-path write is denied

- **WHEN** an explicit readonly worker's `forge_shell` call carries `node tools/gen.mjs --out src/generated.ts` where the parsed output target resolves inside the workspace
- **THEN** the spawn is denied (workspace-write indicator) — parsing uses the command string only, at classify time, with no fs access

#### Scenario: Write-shaped and absent-shaped workers are never sealed

- **WHEN** a session runs a `shape: "write"` agent or an agent with NO shape field (the open default) and calls `forge_shell` with any command
- **THEN** the exec channel applies no write-class denial — the seal keys on the explicit readonly shape only

#### Scenario: Unclassifiable commands flow and the bypass surface is disclosed

- **WHEN** a command's write intent hides behind indirection the classifier does not model (a script that writes internally, `Start-Process` writers, encoded payloads)
- **THEN** the command flows (fail-open on the channel), and the README discloses this bypass surface verbatim alongside the covered indicator list — the seal is belt-in-depth, not a sandbox

#### Scenario: The seal composes with the draft posture

- **WHEN** an explicit readonly worker's `forge_shell` call arrives during a plan-draft phase on a governed session
- **THEN** the existing draft-phase ask/deny semantics apply unchanged — the seal neither weakens nor replaces them
