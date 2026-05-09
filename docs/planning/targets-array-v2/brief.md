# Brief: targets[] array — v2 contract runtime model

Bookmarked 2026-05-06. v1 work shipped (target.type: "pm2" added, env-only
contracts no longer auto-run). This brief captures the full v2 vision.

## What v1 already shipped (additive, non-breaking)

- `target.type` is now a discriminated union: `"docker-compose"` or `"pm2"`.
- PM2 selection rule changed from "has location, not target-only" →
  "has target.type === 'pm2' OR has legacy `dev` field."
- Env-only contracts (no target, no `dev`) correctly skip PM2 — fixed the
  datadog bug where they were being launched with default `pnpm dev`.
- Existing contracts with `dev` field keep working (legacy fallback).

## What v2 changes

### 1. `targets` array

A contract can declare multiple runtime targets:

```json
{
  "name": "api",
  "location": "apps/api",
  "vars": { ... },
  "targets": [
    { "type": "pm2", "command": "pnpm dev", "label": "API" },
    { "type": "docker-compose", "file": "docker-compose.yml", "service": "api", "config": { ... } }
  ]
}
```

Use case: same contract, two ways to run. `pnpm ce pm2:start local` uses
the PM2 target (hot reload). `pnpm ce dc:up local` uses the Docker target
(test the container locally). Same vars, same component refs, two outputs.

### 2. `target` (singular) becomes shorthand for `targets: [target]`

Backwards compatible. Both shapes parse equivalently. Tools internally
normalize to `targets[]`.

### 3. Runtime-specific fields move into the target

Top-level fields that today describe runtime behavior get folded into the
relevant target object:

| Today (top-level) | v2 (inside target)                           |
|-------------------|----------------------------------------------|
| `dev`             | `targets: [{ type: "pm2", ...dev }]`         |
| `persistent: true`| `targets: [{ type: "docker-compose", persistent: true, ... }]` |
| `serve.build`     | `targets: [{ type: "docker-compose", serve: { build, config } }]` |
| `serve.config`    | (same as above)                              |

Top-level fields that describe **env resolution** stay where they are:
`vars`, `location`, `outputs`, `defaults`, `default`, `ignoreDefault`,
`includeVars`, `onlyProfiles`. These are profile-time concerns, not
runtime concerns.

### 4. Validation rules

- At most one `pm2` target per contract (PM2 process names are 1:1 with
  contract names).
- At most one `docker-compose` target per file (compose service names must
  be unique within a file). Multiple `docker-compose` targets writing to
  *different* files (e.g., main + persistent compose) would be valid.
- A contract with no targets at all is valid — env-only output. Today's
  datadog case.

## Migration

`ce migrate` would translate:

```json
// before
{
  "name": "api",
  "location": "apps/api",
  "dev": { "command": "pnpm dev", "label": "API" },
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "api",
    "config": { ... }
  },
  "persistent": false,
  "serve": { "build": "turbo build --filter=@org/api" }
}

// after
{
  "name": "api",
  "location": "apps/api",
  "targets": [
    { "type": "pm2", "command": "pnpm dev", "label": "API" },
    {
      "type": "docker-compose",
      "file": "docker-compose.yml",
      "service": "api",
      "config": { ... },
      "serve": { "build": "turbo build --filter=@org/api" }
    }
  ]
}
```

Auto-migration is safe — it's a mechanical rewrite.

## Why this is worth doing

- One consistent rule: top-level = env resolution, target = runtime. No
  more guessing what implies what.
- Single contract supports both PM2 and Docker workflows without forking
  into two contracts.
- `persistent`, `serve`, future runtime-specific fields stop polluting the
  top level.
- Sets up cleanly for additional target types later (`kubernetes`,
  `process-compose`, `systemd`, etc.) — each just gets its own type
  discriminator.

## Open questions

- Should `targets` be allowed to be empty (`[]`) explicitly, or should
  omitting the field be the only way to express "no runtime"?
- Compose-service-uniqueness validation: error or warn? Some compose
  setups intentionally have multiple services with the same name in
  different files (overrides, etc.).
- Migration command: `ce migrate` exists for vars format migration —
  extend it, or new `ce migrate:targets`?
- Versioning: ship v2 as a major bump (2.0.0) with a deprecation period
  for the old shapes. Probably 1-2 minor releases of warnings before
  removal.

## Related shipped work

- v1.22.0 — `outputs` map + ~/abs path support (env file output flexibility)
- v1.23.0 (this commit) — `target.type: "pm2"` discriminator + env-only
  contracts no longer auto-run.
