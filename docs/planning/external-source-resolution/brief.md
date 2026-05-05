# Brief: external source resolution with fallbacks

Bookmarked 2026-04-21 from real-world friction in a downstream project's
e2e test setup (reschedule-postcall PR). Not yet designed — capture only.

## Problem

Per-dev secrets and env-specific overrides currently get pasted into shared
component files or `.env.secrets.shared`, which:

1. Forces every dev to share the same secret value (or hand-edit locally,
   which drifts).
2. Couples secrets to the shape of the contracts (every contract that
   references a secret has to know about its shape).
3. Doesn't compose with external secret managers (1Password, AWS Secrets
   Manager, Doppler, Infisical) where engineering already stores secrets.
4. Doesn't model "this var has a sensible default but a dev can flip it
   locally without committing" — the closest workaround is `.env.secrets.local`,
   which is opaque and per-file rather than per-key.

## Sketch

Components could declare external sources with fallbacks:

```yaml
INNGEST_DEV:
  default: "false"
  external:
    op: "op://avoca/inngest/dev_mode"
    env: ALLOW_OVERRIDE_INNGEST_DEV
  description: "If true, Inngest SDK routes to localhost:8288"
```

Build behavior:

1. If `external.env` is set in the dev's shell, use it.
2. Else if `external.op` resolves (1Password CLI is authenticated), use it.
3. Else fall back to `default`.

Each external source plugs in via a small adapter (`op`, `aws-sm`, `doppler`,
etc.). Adapters are opt-in — projects only pull in the ones they need.

## Why this scales

- Secrets stay in their canonical store (1Password etc.) instead of being
  duplicated into ce config.
- Per-dev overrides are explicit and discoverable (the `external.env` field
  documents exactly which env var flips behavior).
- New projects inherit the pattern: same component shape, different sources.
- Builds become reproducible — given the same source set and dev identity,
  the same env file is generated.

## Open questions

- How does this interact with `${secrets.KEY}` resolution in the existing
  vault flow? Probably: external sources resolve first, vault is one of the
  external sources.
- Caching — 1Password CLI is slow. Cache resolved values for the lifetime of
  a single `ce build` invocation? Persist between invocations with a TTL?
- Failure mode when an adapter fails (network down, op CLI not authed) —
  hard fail, warn-and-fall-back, or per-key configurable?
- Do external sources belong in components or contracts? Probably components,
  since the source maps to a value, not a service-specific binding.

## Related

- Existing vault feature (`.env.secrets.shared` + age encryption) — likely
  becomes one of several external sources rather than the only secret path.
- Existing `${secrets.KEY}` reference syntax — would extend naturally to
  resolve via the same chain.
