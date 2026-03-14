---
title: "ADR: Simplify Variable Resolution — 3 Concepts, 1 Hop Each"
date: 2026-03-03
status: proposed
---

# ADR: Simplify Variable Resolution — 3 Concepts, 1 Hop Each

## Y-Statement

In the context of **how environment variables flow from source-of-truth to generated .env files**,
facing **a namespace-prefix-then-unprefix pattern that creates 3+ hops to trace any variable, with real-world monorepos accumulating 47 component files, 11 interfaces, and 6,500 lines of env management code**,
we decided for **a three-concept model (secrets, components, contracts) where each concept is one hop and components hold the full picture of a concern including secret references**
and against **keeping the NAMESPACE auto-prefix system, removing components entirely, and keeping secrets and non-secrets in separate file hierarchies**,
to achieve **30-second variable tracing (open contract → open component → done) and 2-file edits to add a new variable**,
accepting **a breaking change to the contract format (new `vars` field replaces `required`/`optional`/`secret`) and the removal of NAMESPACE auto-prefixing**,
because **the current system's friction-to-value ratio is wrong — developers pay a daily tax (3-5 files per variable, 5-10 minutes to trace) for flexibility that's rarely exercised**.

## Context

### The current flow (too many hops)

Follow a Redis URL through the existing system:

```
secrets (.env.shared)              → SECRET_REDIS_DEV_URL=redis://...
component (redis.env [staging])    → JOB_QUEUE_URL=${SECRET_REDIS_DEV_URL}   (auto-prefixed to REDIS_JOB_QUEUE_URL)
interface/contract                 → "REDIS_URL": "REDIS_JOB_QUEUE_URL"      (un-prefixed back)
app .env (generated)               → REDIS_URL=redis://...
```

Three hops. The middle two exist only to namespace and then un-namespace the same value. The NAMESPACE system prevents collisions in a global pool — but contracts already scope variables to individual services. The collision prevention solves a problem that contracts already solve.

### What this looks like at scale

From a real monorepo audit:
- 47 component files, 13 profiles, 11 service interfaces
- 6,500+ lines of custom env management code
- Adding one new env var touches 3-5 files minimum
- Tracing where a variable comes from takes 5-10 minutes
- Per-profile secret key names (`SECRET_REDIS_DEV_URL`, `SECRET_REDIS_STG_URL`, `SECRET_REDIS_PROD_URL`) that differ only by environment suffix

### What's legitimate complexity vs. over-engineering

**Legitimate:**
- Multiple apps needing different env vars per environment
- Separating team secrets from personal overrides
- Validating required vars before runtime

**Over-engineered:**
- Variable aliasing round-trip (namespace-prefix then un-prefix)
- Secrets separated from their usage context (open redis.env, still need another file to see the actual URL)
- Per-profile secret key naming (`SECRET_REDIS_DEV_URL` vs `SECRET_REDIS_PROD_URL`)
- TypeScript interface files for what's fundamentally a key→key mapping

## Decision

### Three concepts, one hop each

#### 1. Secrets (gitignored)

Raw credential values. Two files following the existing naming pattern:

```env
# env/.env.secrets.shared (team secrets — encrypted via vault, committed)
REDIS_URL=CENV_ENC[...]
DASH0_AUTH_TOKEN=CENV_ENC[...]
DB_PASSWORD=CENV_ENC[...]
```

```env
# env/.env.secrets.local (personal secret overrides — gitignored, never committed)
REDIS_URL=redis://localhost:6379
DB_USER=postgres
DB_PASSWORD=localdev
DB_HOST=localhost
```

This mirrors the existing `.env.shared` / `.env.local` pattern. Team secrets go in `.env.secrets.shared` (encrypted via vault, safe to commit). Personal credentials and local dev values go in `.env.secrets.local` (gitignored).

No more `SECRET_REDIS_DEV_URL` / `SECRET_REDIS_PROD_URL` — just `REDIS_URL`. Profile-specific secret values can be handled via profile sections within the secrets files, or by the component's profile sections selecting different non-secret config while the secret stays the same.

#### 2. Components (committed, one per concern)

The full picture of a concern — secrets AND non-secrets together. Open `redis.env` and see everything about Redis. No hunting across files.

```ini
; redis.env — everything about Redis, in one place
[default]
JOB_QUEUE_URL=${secrets.REDIS_URL}
DB=0
CLI_COMMAND=redis-cli -u ${secrets.REDIS_URL}

[production]
DB=2
```

```ini
; telemetry.env — observability concern
[default]
LOG_LEVEL=info
LOG_LEVEL_CONSOLE=debug
LOG_LEVEL_OTLP=warn
DASH0_ENDPOINT=https://otlp.dash0.com
DASH0_DATASET=default
DASH0_AUTH_TOKEN=${secrets.DASH0_AUTH_TOKEN}
```

```ini
; database.env
[default]
URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp
DIRECT_URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5433/myapp
```

No `NAMESPACE=` directive. The component filename IS the namespace. Variables use simple names (`JOB_QUEUE_URL`, not `REDIS_JOB_QUEUE_URL`). Secret references use `${secrets.KEY}` — the component doesn't know or care where the secret comes from, just that it needs one.

Components still have profile sections (`[default]`, `[production]`) for values that genuinely differ per environment (log levels, feature flags, database names). But secrets resolution is handled by the secrets layer, not by profile-specific secret key names.

#### 3. Contracts (committed, one per app)

Maps component values to whatever env var name the app expects. This IS the aliasing layer — but it's explicit, one level deep, and readable in 5 seconds.

```json
{
  "name": "job-queue-api",
  "location": "apps/api",
  "vars": {
    "NODE_ENV": "${job-queue-api.NODE_ENV}",
    "REDIS_URL": "${redis.JOB_QUEUE_URL}",
    "HUB_REDIS_URL": "${redis.JOB_QUEUE_URL}",
    "DATABASE_URL": "${database.URL}",
    "LOG_LEVEL": "${telemetry.LOG_LEVEL}",
    "DASH0_AUTH_TOKEN": "${telemetry.DASH0_AUTH_TOKEN}",
    "API_PORT": "${job-queue-api.PORT}"
  },
  "defaults": {
    "OTEL_SERVICE_NAME": "job-api",
    "OTEL_SERVICE_NAMESPACE": "emp",
    "SERVICE_TYPE": "api"
  },
  "dev": {
    "command": "pnpm dev",
    "label": "Job Queue API"
  }
}
```

The `vars` field replaces the current `required` / `optional` / `secret` split. Every mapping uses the `${component.KEY}` syntax. `defaults` provides fallback values that don't come from components. The `dev` field (from v0.6.0) stays unchanged.

### Generated output: `.env.{profile}`

Generated files use the standard `.env.{profile}` naming instead of `.ce.{profile}`:

```
apps/api/.env.production      # not .ce.production
apps/web/.env.staging
apps/worker/.env.default
```

This is what every tool already expects — dotenv, Next.js, Vite, Docker, etc. No custom prefix. The files are still gitignored and generated by `ce build`.

### 30-second variable tracing

To find where `REDIS_URL` comes from in `apps/api`:
1. Open `api.contract.json` → see `"REDIS_URL": "${redis.JOB_QUEUE_URL}"`
2. Open `redis.env` → see `JOB_QUEUE_URL=${secrets.REDIS_URL}`
3. Done. Two files, 30 seconds.

### Resolution chain (simplified)

```
.env.secrets.shared + .env.secrets.local  →  raw credentials (local overrides team)
  ↓
components/*.env [section]                →  ${secrets.KEY} resolved, profile sections merged
  ↓
contracts/*.contract.json                 →  ${component.KEY} resolved, output written
  ↓
apps/api/.env.production                  →  generated .env file
```

Each arrow is one hop. No flattening into a global pool. No namespace prefixing/unprefixing.

### File layout

```
env/
  components/           # Committed — one per concern
    database.env
    redis.env
    telemetry.env
  profiles/             # Committed — named compositions
    default.json
    production.json
    staging.json
  contracts/            # Committed — one per app/service
    api.contract.json
    web.contract.json
    worker.contract.json
  execution/            # Committed — Zellij layout templates (optional)
    default.kdl.template
  .env.secrets.shared   # Committed — team secrets (encrypted via vault)
  .env.secrets.local    # Gitignored — personal secret overrides
  .env.local            # Gitignored — personal non-secret overrides (last layer)
  .recipients           # Committed — vault recipient public keys
```

### What changes from the current model

| Current | New |
|---------|-----|
| `"required": { "REDIS_URL": "REDIS_JOB_QUEUE_URL" }` | `"vars": { "REDIS_URL": "${redis.JOB_QUEUE_URL}" }` |
| `"secret": { "JWT_SECRET": "AUTH_JWT_SECRET" }` | `"vars": { "JWT_SECRET": "${auth.JWT_SECRET}" }` |
| `"optional": { "LOG_LEVEL": "LOG_LEVEL" }` | `"vars": { "LOG_LEVEL": "${telemetry.LOG_LEVEL}" }` + `"defaults"` |
| `NAMESPACE=REDIS` in redis.env | Component filename = namespace (no directive) |
| `SECRET_REDIS_DEV_URL` / `SECRET_REDIS_PROD_URL` | `REDIS_URL` in `.env.secrets.shared` / `.env.secrets.local` |
| `.env.shared` for both secrets and shared values | `.env.secrets.shared` for secrets, components for non-secret values |
| `.env.local` for all personal overrides | `.env.secrets.local` for secret overrides, `.env.local` for non-secret overrides |
| Generated files: `.ce.production` | Generated files: `.env.production` |

### What stays the same

- Components organized by concern (redis, database, telemetry)
- Profile system for per-environment overrides (sections in component files)
- Atomic validation — all contracts validated before any files are written
- `ce build`, `ce run`, `ce start`, `ce scripts` commands
- Vault for encrypting secrets in committed files
- `.env.local` for personal non-secret overrides (last layer, highest priority)

## Alternatives Considered

### Keep NAMESPACE, add tracing tooling

Add a `ce trace <VAR>` command that shows the full resolution chain. This addresses the symptom (hard to trace) but not the cause (unnecessary indirection). Developers still touch 3-5 files to add a variable. Tooling around bad architecture is worse than fixing the architecture.

### Remove components entirely, use flat .env files per profile

```
.env.local
.env.staging
.env.production
```

Simpler but loses the legitimate value of components: organizing related variables by concern, sharing database config across services without duplication, and having one file that shows everything about a concern. Throws out the baby with the bathwater.

### Implicit NAMESPACE from filename (auto-prefix without the directive)

Keep auto-prefixing but derive it from the filename (`database.env` → `DATABASE_` prefix). Still creates the round-trip — contracts still reference `DATABASE_HOST` with the baked-in prefix. Doesn't solve the core issue.

### Keep `required`/`optional`/`secret` split in contracts

The three-field split forces the contract author to categorize every variable by sensitivity and optionality at declaration time. In practice, what's "optional" vs "required" changes, and the split makes contracts harder to scan. A flat `vars` map with `defaults` for fallbacks is simpler. Validation can derive required vs optional: if it's in `vars` but not in `defaults`, it's required.

### Secrets in a separate `env/secrets/` directory

Per-profile secrets files in a subdirectory (`env/secrets/default.env`, `env/secrets/production.env`). Rejected in favor of `.env.secrets.shared` / `.env.secrets.local` because it follows the existing `.env.shared` / `.env.local` naming pattern, avoids directory proliferation, and keeps the team/personal override model that developers already understand.

### Keep `.ce.{profile}` output naming

The `.ce.` prefix avoids collisions with manually-created `.env` files. But in practice, the generated file IS the .env file — there's no manually-created one alongside it. `.env.{profile}` is universally recognized by dotenv, Next.js, Vite, Docker, and every other tool. The `.ce.` prefix forces teams to configure custom dotenv paths. Standard naming just works.

## Consequences

### Positive
- 30-second variable tracing: contract → component → done
- Adding a new env var is a 2-file operation (component + contract)
- Components show the full picture of a concern (no hunting across files)
- No NAMESPACE mental model to learn
- Secrets use the same key name everywhere (no `SECRET_REDIS_DEV_URL` naming)
- Contract is self-documenting — `${redis.JOB_QUEUE_URL}` tells you exactly where it comes from
- `vars` map is scannable — one flat list of everything the app gets
- `.env.{profile}` output works with every tool out of the box
- `.env.secrets.shared` / `.env.secrets.local` follows familiar naming conventions

### Negative
- Breaking change to contract format (`required`/`optional`/`secret` → `vars`)
- NAMESPACE removal requires migrating all existing component files
- Component filenames become semantically significant (renaming `redis.env` to `cache.env` breaks contracts)
- Loss of explicit required/optional distinction in contract schema (derived from `defaults` instead)
- `.env.{profile}` could collide with manually-created .env files in apps that predate composable.env adoption

### Risks
- **Migration burden**: Projects with many contracts need mechanical edits. Mitigate with a `ce migrate` command that rewrites contracts and components automatically.
- **Validation regression**: Current system explicitly marks required vs optional. New system infers this (in `vars` but not in `defaults` = required). Need to verify this catches all the same errors.
- **Output name collisions**: Apps with existing `.env.production` files will have them overwritten. Mitigate with a warning during `ce build` if a non-generated `.env.{profile}` already exists, and add a comment header (`# Generated by composable.env — DO NOT EDIT`) for identification.
- **Gitignore pattern change**: `.ce.*` pattern must be updated to `.env.*` or more specific patterns to avoid gitignoring unrelated .env files. Need careful pattern design (e.g., only gitignore `.env.{known-profiles}`).

## References

- Current NAMESPACE implementation: `src/builder.ts` `loadComponentConfig()` — line 500
- Current contract resolution: `src/contracts.ts` `resolveMapping()` — line 206
- Current contract format: `examples/fullstack/env/contracts/`
- Real-world audit: 47-component monorepo with 5-10 minute variable tracing
- Zellij execution addon (v0.6.0): contract `dev` field carries forward unchanged
