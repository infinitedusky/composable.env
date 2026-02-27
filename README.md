# composable.env

> Build `.env` files for every service from reusable **components**, **profiles**, and **contracts**.

Like CSS for environment variables. Define once, compose everywhere, validate against contracts.

```bash
npm install -g composable.env
cenv build --profile production
```

---

## The problem

Managing `.env` files across multiple services and environments leads to:
- Copy-pasted values that drift out of sync
- No validation — missing variables fail at runtime, not build time
- No inheritance — `staging` and `production` have 90% overlap but no shared base
- Secrets scattered across files with no clear team vs personal boundary

## The solution: three building blocks

### Components
Reusable `.env` variable definitions, organized by sections:

```ini
# env/components/database.env
NAMESPACE=DATABASE

[default]
HOST=localhost
PORT=5432

[production]
HOST=${DATABASE_PROD_HOST}

[staging]
HOST=${DATABASE_STAGING_HOST}
```

### Profiles
Named compositions of components. Profiles can extend each other.

```json
// env/profiles/staging.json
{
  "name": "Staging",
  "description": "Staging environment",
  "extends": "production",
  "components": {
    "database": "staging",
    "redis": "staging"
  }
}
```

### Contracts
TypeScript files that declare what a service requires. The build fails if any required variable is missing.

```typescript
// env/contracts/api.contract.ts
import type { ServiceContract } from 'composable.env';

export const ApiContract: ServiceContract = {
  name: 'api',
  location: 'apps/api',     // where to write .env.production
  required: {
    DATABASE_URL: '${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}',
    REDIS_URL: 'REDIS_URL',
  },
  optional: {
    LOG_LEVEL: 'LOG_LEVEL',
  },
  defaults: {
    LOG_LEVEL: 'info',
  },
};
```

---

## Directory structure

```
env/
  components/         # Reusable variable definitions
    database.env
    redis.env
    auth.env
  profiles/           # Named environment compositions
    default.json      # Lists all component names (required)
    production.json
    staging.json
  contracts/          # Per-service variable requirements (optional)
    api.contract.ts
    worker.contract.ts
  .env.shared         # Team-wide raw values (can be committed)
  .env.local          # Personal overrides (always gitignored)
```

---

## Getting started

```bash
# Scaffold the directory structure
cenv init

# List available profiles
cenv list

# Build all service .env files from a profile
cenv build --profile production

# Build from a profile, single output file
cenv build --profile staging --output .env.staging
```

---

## How it works

1. **Load** `default.json` to get all component names
2. **Resolve** profile inheritance chain (e.g., `staging → production → default`)
3. **Compose** each component's sections in order: `[default]` → `[production]` → `[staging]`
4. **Layer** `.env.shared` (team values) then `.env.local` (personal overrides)
5. **Resolve** `${VAR}` substitutions with multi-pass chaining
6. **Validate** against all contracts — fail atomically if any required variable is missing
7. **Write** one `.env.{profile}` file per contract at the service's `location`

---

## Component files

Components are INI files with named sections. The section name matches the profile name by convention — no explicit mapping needed.

```ini
NAMESPACE=REDIS        # Optional: prefix all vars with REDIS_

[default]
URL=redis://localhost:6379

[production]
URL=${REDIS_PROD_URL}  # Resolved from .env.shared or .env.local

[staging]
URL=${REDIS_STAGING_URL}
```

Variables are prefixed with `NAMESPACE_` when set:
- `URL` in `[default]` → `REDIS_URL=redis://localhost:6379`

---

## Profile inheritance

Child profiles inherit all parent components and can selectively override:

```json
{
  "extends": "production",
  "components": {
    "database": "staging"   // only override database
    // everything else inherits from production
  }
}
```

---

## Shared vs local values

| File | Purpose | Committed? |
|------|---------|-----------|
| `env/.env.shared` | Team-wide raw values | Your choice |
| `env/.env.local` | Personal overrides | Never (gitignored) |

`.env.local` always takes precedence over `.env.shared`.

---

## Contracts

Contracts are optional but powerful. They:
- Declare exactly what a service needs
- Map system variable names to app variable names
- Support template values: `"${HOST}:${PORT}"`
- Support fallback chains: `"TUNNEL_URL : LOCAL_URL"`
- Fail the entire build if any required variable is missing (atomic)

Export name convention: `PascalCaseContract`
```typescript
// env/contracts/my-worker.contract.ts
export const MyWorkerContract: ServiceContract = { ... }
```

---

## Programmatic API

```typescript
import { EnvironmentBuilder } from 'composable.env';

const builder = new EnvironmentBuilder(
  process.cwd(),   // configDir (where env/ lives)
  '.env',          // outputPath (for single-file builds)
  'production'     // envName (suffix for .env.{profile} files)
);

const result = await builder.buildFromProfile('production');
if (!result.success) {
  console.error(result.errors);
  process.exit(1);
}
```

---

## License

MIT
