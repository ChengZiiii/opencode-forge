# fix-v2-anchor-field-reality

## Why

On the real opencode 2.3.2 host, the sole-pool-ownership anchor resolver
silently skipped workspace anchor resolution: `v2AnchorCandidates` only
accepted zero-arg function-shaped anchor fields, but 2.3.2 exposes
`ctx.location.directory` as a plain string property and carries no
`worktree` field at all (verified live with a temporary probe plugin).
The result: the `forge-plugindev-*` pool workers never materialized,
`/api/agent` answered 500, and the forge tool belt was absent on the
user's primary machine even though forge 0.27.0 loaded "successfully".
The functional guard designed against shape drift became the shape-drift
failure itself.

## What Changes

- `v2AnchorCandidates` (and the anchor resolution it feeds) now accepts
  BOTH shapes: a property value (string) or a zero-arg function, reading
  the property directly when it is not callable; absent anchor fields
  keep falling through to the remaining candidates instead of failing.
- No behavior change on hosts where anchors are function-shaped: the
  function path is unchanged and still wins shape detection order.
- Shipped as `@sorenllm/opencode-forge@0.27.1` (commit `a72c86e`, pushed
  to `ChengZiiii/opencode-forge`), with the full 717-test suite green and
  live verification: all five `forge-plugindev-*` workers materialized on
  the 2.3.2 host and the forge tool belt restored.

## Capabilities

### Modified Capabilities

- `forge-agent`: the "v2 forward-compatible registration" requirement is
  amended — anchor/field resolution SHALL accept property-shaped anchor
  fields as well as function-shaped ones, with absent fields falling
  through to remaining candidates.
