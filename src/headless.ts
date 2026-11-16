// Headless ask liveness (spec: tool-partition — "Headless ask liveness on
// the exec surface", change dispatch-resilience fold A): the host-property
// resolver that decides whether forge_shell may resolve a would-ask posture
// without a dialog. PURE function core — no process access, no side effects,
// fully injectable (env map + argv array), unit-tested in
// tests/headless-gate.test.mjs.
//
// Semantics (law: the spec delta):
// - `FORGE_HEADLESS=1` forces headless; `FORGE_HEADLESS=0` forces
//   interactive. Any other value (or unset) falls back to auto-detect —
//   invalid values fall back to the default, matching the shipped env-knob
//   tolerance convention.
// - Auto-detect: serve mode from the HOST process argv. The plugin runs
//   in-process with the host, so `opencode serve` puts a literal `serve`
//   subcommand token in process.argv (node ["node","…/opencode","serve"],
//   bun ["bun","…/opencode","serve"], single-binary ["/…/opencode","serve"]
//   — token equality on every shape; argv[0] is skipped so a binary NAMED
//   "serve" cannot trip it, and a path token can never equal a bare
//   "serve").
// - `opencode run` mode is NOT headless: its argv carries `run`, no `serve`
//   token — auto-detect lands interactive and the existing ask
//   auto-reject semantics are untouched for the default posture.

/** Resolve the headless host property. Pure; deterministic per process
 * (env and argv do not change mid-host). */
export function resolveHeadlessMode(
  env: { FORGE_HEADLESS?: string | undefined },
  argv: readonly string[],
): boolean {
  const raw = env.FORGE_HEADLESS
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  // Auto-detect: serve subcommand token in the host argv (see header).
  // `opencode run` and the TUI carry no bare "serve" token → interactive.
  return argv.slice(1).some((tok) => tok === "serve")
}
