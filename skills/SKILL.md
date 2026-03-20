---
description: Work with composable.env — build, debug, scaffold, and manage environment configuration
---

You are helping a user work with **composable.env** (`ce`), a tool that builds `.env` files and Docker Compose files for every service from reusable components, profiles, and contracts.

## What composable.env solves

In any project with multiple services (APIs, workers, frontends, databases), each service needs environment variables — and many of them overlap. Without ce, you end up with:
- Scattered `.env` files with duplicated values across services
- Secrets committed to git or shared insecurely
- No way to switch between local/staging/production without manual editing
- Docker Compose files with hardcoded secrets that can't be versioned

ce solves this by separating **what values exist** (components) from **who needs them** (contracts) and **which environment** (profiles). You version the contracts and components in git, and ce generates the `.env` files and `docker-compose.yml` as build artifacts — with secrets resolved at build time, never committed.

## Getting started with a new project

### Prerequisites

- **Node.js 18+** and a package manager (pnpm recommended)
- **OrbStack** (recommended) or Docker Desktop for running containers locally. OrbStack is faster, lighter, and provides automatic `.orb.local` DNS for containers.

### Setup

```bash
# Install composable.env (provides the `ce` CLI command)
pnpm add -D composable.env

# Scaffold the env directory and ce.json
pnpm ce init

# Set your default profile
# Edit ce.json: { "defaultProfile": "local" }
```

### First component

Create a component for each logical service (database, redis, your app):

```ini
# env/components/database.env
[default]
HOST=localhost
PORT=5432
USER=postgres
PASSWORD=${secrets.DB_PASSWORD}
NAME=myapp_dev
URL=postgresql://${database.USER}:${database.PASSWORD}@${database.HOST}:${database.PORT}/${database.NAME}
```

### First profile

Create `env/profiles/local.json` — even if it's empty, it defines "local" as a profile:

```json
{ "name": "local", "description": "Local development" }
```

### First contract

```json
// env/contracts/api.contract.json
{
  "name": "api",
  "location": "apps/api",
  "vars": {
    "DATABASE_URL": "${database.URL}",
    "PORT": "${api.PORT}"
  },
  "defaults": {
    "LOG_LEVEL": "info"
  }
}
```

### First secrets file

```ini
# env/.env.secrets.shared — distribute to team, never commit
DB_PASSWORD=local-dev-password
```

### Build and verify

```bash
pnpm ce build              # builds .env.local in apps/api/
pnpm ce list               # shows components, profiles, contracts
```

### Quick start with Docker scaffold

For Docker-based projects with Next.js and VitePress docs, use the scaffold:

```bash
pnpm ce init --scaffold docker
```

This creates everything above plus:
- `local` and `production` profiles
- `networking.env` component with OrbStack `.orb.local` DNS setup
- `networking.vars.json` for shared networking vars across contracts
- `docker/Dockerfile.nextdev` (hot reload via volume mounts)
- `docker/Dockerfile.nextprod` (standalone production build)
- `docker/Dockerfile.vitepressdev` (VitePress hot reload)
- `docker/Dockerfile.vitepressprod` (VitePress static build with nginx)
- `apps/docs/` with full VitePress site (config.ts, index.md, guide pages)
- Example app contract with docker-compose target + `profileOverrides`
- Docs contract with docker-compose target
- `docker-compose.yml` added to `.gitignore` (it contains resolved secrets)
- `ce.json` defaultProfile set to `local`

## Architecture

- **ce.json** — Optional root config. Sets `envDir` (default `"env"`) and `defaultProfile` (default `"default"`). Scaffolded by `ce init`.
- **Components** (`env/components/*.env`) — INI files with `[default]`, `[production]`, etc. sections. Auto-discovered from filesystem. This is where non-secret, shared values live — they get versioned in git.
- **Profiles** (`env/profiles/*.json`) — Optional section overrides per environment. Support `"extends"` inheritance.
- **Contracts** (`env/contracts/*.contract.json`) — Declare what variables a service needs via `vars` field with `${component.KEY}` references.
- **Var sets** (`env/contracts/*.vars.json`) — Reusable variable bundles. Contracts use `includeVars: ["platform-base"]` to inherit shared vars. Var sets can chain. Contract's own vars win on conflict.

## Value layers — who is each file for?

The file system is organized by **audience**, not by environment or profile:

| File | Sensitive? | Audience | In git? | Purpose |
|------|-----------|----------|---------|---------|
| `env/components/*.env` | No | Everyone | Yes | Non-secret shared values. The main source of truth. Versioned because they apply to all developers and all environments. |
| `env/.env.secrets.shared` | Yes | All devs on the project | **No** — passed around manually or via vault | Team secrets that every developer needs (DB passwords, API keys, etc.). Not committed because they're sensitive, but "shared" means the file is distributed to the team. |
| `env/.env.secrets.local` | Yes | One developer | No | Personal secrets for that developer's specific environment. Example: credentials for their personal staging environment. |
| `env/.env.local` | No | One developer | No | Personal non-secret overrides. Rarely used — only for values specific to one developer's setup (e.g., a custom port or log level). Not sensitive, just not relevant to anyone else. |

### The mental model

- **Shared, non-secret** → goes directly in component files (versioned in git)
- **Shared, secret** → goes in `.env.secrets.shared` (distributed to team, not committed)
- **Personal, secret** → goes in `.env.secrets.local` (one developer only)
- **Personal, non-secret** → goes in `.env.local` (one developer only, rarely needed)

### Example: personal staging environments

Say every developer has their own staging environment they can share with teammates for review ("hey, can you check if this works?"). Each developer would put their staging credentials in `.env.secrets.local`:

```ini
# .env.secrets.local — my personal staging
STAGING_DB_PASSWORD=my-unique-staging-pw
STAGING_HOST=alice-staging.example.com
```

These override the team defaults in `.env.secrets.shared` for that developer only.

### Why secrets flow through components

Secrets should always be referenced in components via `${secrets.KEY}`, and contracts should reference components — never secrets directly. The reason: the value a component exposes may or may not actually be secret. A `DATABASE_URL` might contain a secret password today but be a local socket path tomorrow. Components and contracts handle the mapping of values to apps and profiles. Secrets are just a protection layer — a way of keeping sensitive values out of git or scoped to a specific developer.

```
secrets → referenced in components → components referenced in contracts → output .env files
```

Never short-circuit this: `contracts → secrets` directly.

## Resolution chain

```
secrets (.env.secrets.shared + .env.secrets.local)
  → components[default] + components[profile sections]
    → Pass 1: resolve ${secrets.KEY} in components
    → Pass 2: resolve ${component.KEY} cross-references
    → .env.local (personal non-secret overrides)
      → contract vars mapping: ${component.KEY} → app variable names
        → defaults for unresolved vars
          → write .env.{profile} per location OR update docker-compose.yml per target
```

## CLI commands

| Command | Purpose |
|---------|---------|
| `ce init` | Scaffold env/ directory and ce.json. `--scaffold docker` adds Docker + Next.js + VitePress setup. |
| `ce build [profile]` | Build .env files + docker-compose.yml. With `--profile X`: only `.env.X`. Without: all profiles. Compose file always includes all profiles. |
| `ce start [profile]` | Build + launch PM2 dev environment |
| `ce list` | Show components, profiles, contracts |
| `ce run [profile] -- <cmd>` | Build then run a command |
| `ce vault init` | Initialize age-encrypted vault |
| `ce vault set KEY=VALUE` | Encrypt a secret |
| `ce vault get KEY` | Decrypt a secret |
| `ce migrate` | Convert legacy format to vars format |
| `ce add-skill` | Install Claude Code skill |
| `ce persistent up/down/destroy/status` | Manage persistent Docker services (databases, caches) |
| `ce uninstall` | Remove all ce artifacts |

## ce.json

```json
{
  "envDir": "env",
  "defaultProfile": "local"
}
```

Profile resolution: `--profile` flag > `CE_PROFILE` env var > `ce.json defaultProfile` > `"default"`

## Contract format

```json
{
  "name": "api",
  "location": "apps/api",
  "vars": {
    "DATABASE_URL": "${database.URL}",
    "REDIS_URL": "${redis.URL}",
    "JWT_SECRET": "${auth.JWT_SECRET}",
    "LOG_LEVEL": "${api.LOG_LEVEL}"
  },
  "defaults": {
    "LOG_LEVEL": "info"
  },
  "dev": {
    "command": "pnpm dev",
    "label": "API Server"
  }
}
```

- Left side = app variable name (what the service sees)
- Right side = **always** a `${component.KEY}` reference. Contracts only reference components, never secrets directly. Secrets flow through components (`${secrets.KEY}` in a component, `${component.KEY}` in a contract).
- `defaults` is the **only** place for hardcoded values in a contract — static fallbacks like `LOG_LEVEL=info`. Everything in `vars` should be a `${component.KEY}` reference so values vary by profile.
- `defaults` provides fallbacks for unresolvable vars
- `dev` defines how `ce start` runs this service via PM2
- `onlyProfiles` — optional array of ce profile names. If set, the contract is only included when building one of those profiles. Useful for dev-only services (log aggregators, debug tools) that shouldn't exist in production builds
- `includeVars` — array of var set names to inherit. Resolves `*.vars.json` files from `env/contracts/`. Merged left-to-right, contract's own vars win on conflict

### Var sets (`*.vars.json`)

Reusable variable bundles that multiple contracts can inherit:

```json
// env/contracts/platform-base.vars.json
{
  "vars": {
    "DATABASE_URL": "${database.URL}",
    "ADMIN_SERVER_URL": "${admin-server.URL}",
    "ADMIN_SERVICE_KEY": "${admin.SERVICE_KEY}"
  }
}
```

```json
// env/contracts/poker.contract.json
{
  "name": "poker",
  "location": "apps/poker",
  "includeVars": ["platform-base"],
  "vars": {
    "NEXT_PUBLIC_WS_HOST": "${game-server.HOST}",
    "PORT": "3666"
  }
}
```

Poker gets all 3 platform-base vars + its 2 own vars. One place to update when platform-wide vars change. Var sets can themselves include other var sets (chaining), with cycle detection.

## Docker Compose target

The `target` field generates an entire docker-compose.yml from contracts. The compose file is a **build artifact** — fully generated, gitignored, contains resolved secrets. Contracts are the versioned source of truth.

A target has two parts:
- **`config`** — the Docker service definition (image, ports, volumes, healthchecks, etc.)
- **`vars`** — resolved environment variables written to the `environment:` block

One contract defines the container, others add vars to it:

```json
// Defines the container itself
{
  "name": "app-container",
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "app",
    "config": {
      "build": { "context": ".", "dockerfile": "Dockerfile" },
      "ports": ["4000:4000"],
      "depends_on": ["redis"],
      "restart": "unless-stopped"
    }
  },
  "vars": {}
}
```

```json
// Adds API vars to the same container
{
  "name": "api",
  "location": "apps/api",
  "target": { "type": "docker-compose", "file": "docker-compose.yml", "service": "app" },
  "vars": {
    "PORT": "${api.PORT}",
    "DATABASE_URL": "${database.URL}",
    "JWT_SECRET": "${auth.JWT_SECRET}"
  },
  "dev": { "command": "pnpm dev" }
}
```

Multiple contracts targeting the same service are **additive** — both `config` (arrays concatenated, objects merged) and `vars` (merged) accumulate. A contract can have `location`, `target`, or both:
- `location` only → writes `.env.{profile}` (local dev)
- `target` only → writes into docker-compose.yml (Docker only)
- Both → writes to both (local dev + Docker from the same contract)

### Multi-profile compose output

When `ce build` detects target contracts, it builds **all profiles** (from `env/profiles/*.json` — not component sections) into one compose file. Shared Docker config (image, ports, volumes) goes into `x-` YAML anchor blocks. Per-profile variants use `<<: *anchor` merge and Docker Compose `profiles:` arrays:

```yaml
x-app: &app-base
  build: { context: ".", dockerfile: "Dockerfile" }
  ports: ["4000:4000"]
  restart: unless-stopped

services:
  app-local:
    <<: *app-base
    profiles: ["local"]
    environment:
      DATABASE_URL: postgresql://localhost:5432/dev

  app-production:
    <<: *app-base
    profiles: ["production"]
    environment:
      DATABASE_URL: postgresql://db.prod.internal:5432/app

  redis-local:
    <<: *redis-base
    profiles: ["local"]
    environment: {}

  redis-production:
    <<: *redis-base
    profiles: ["production"]
    environment: {}
```

Switch environments without rebuilding: `docker compose --profile local up` vs `docker compose --profile production up`.

Every service is always profiled — names are always `{service}-{suffix}` (e.g., `redis-local`). No bare `docker compose up`; always use `--profile`. `onlyProfiles` on contracts controls which profiles include that contract, and `depends_on` references are rewritten to match profiled service names.

**Hostnames are a component concern.** ce does not rewrite environment values to add profile suffixes — that's handled by the `networking.env` component. If a service needs to reference another service's profiled hostname, build it in the component using `${networking.PROFILE_SUFFIX}`:

```ini
# networking.env
[local]
PROFILE_SUFFIX=-local

# game-server.env
[default]
HOST=game-server${networking.PROFILE_SUFFIX}
```

`ce build` (no profile flag) writes `.env.{profile}` for every profile. `ce build --profile X` writes only `.env.X` but the compose file still includes all profiles.

### profileOverrides — per-profile Docker config

When local and production need different Docker config (volumes, command, Dockerfile), use `profileOverrides` on the target:

```json
{
  "name": "poker",
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "poker",
    "config": {
      "build": { "context": ".", "dockerfile": "docker/Dockerfile.nextdev" },
      "ports": ["3666:3666"],
      "volumes": ["./apps/poker:/app/apps/poker"],
      "command": "@numero/poker",
      "restart": "unless-stopped"
    },
    "profileOverrides": {
      "production": {
        "volumes": []
      },
      "staging": {
        "build": { "context": ".", "dockerfile": "docker/Dockerfile.nextprod" },
        "volumes": []
      }
    }
  },
  "vars": { "PORT": "${poker.PORT}" }
}
```

- `config` is the base — goes into the `x-` YAML anchor
- `profileOverrides` keys are profile names, values are partial config overrides
- Merge is **shallow per top-level key**: `"volumes": []` replaces the entire array, not appends
- Keys not mentioned in the override are inherited from the base via `<<: *anchor`
- Use cases: remove volume mounts in production, different Dockerfile per profile, different command (`next dev` vs `next start`)

### Persistent services

Services that should survive rebuild cycles (databases, caches, dev tools) use `"persistent": true` on the contract. They get written to a separate `docker-compose.persistent.yml` instead of the main compose file.

```json
{
  "name": "postgres",
  "persistent": true,
  "onlyProfiles": ["local"],
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "postgres",
    "config": {
      "image": "postgres:16-alpine",
      "ports": ["5432:5432"],
      "volumes": ["pgdata:/var/lib/postgresql/data"],
      "restart": "unless-stopped"
    }
  },
  "vars": { "POSTGRES_PASSWORD": "${secrets.DB_PASSWORD}" }
}
```

Persistent is a **local dev concept** — in production, databases are typically managed services or part of the main compose. Use `onlyProfiles` to control which environments use persistent containers.

Manage with:
- `ce persistent up` — start persistent services (detached)
- `ce persistent down` — stop (preserves volumes)
- `ce persistent destroy` — stop and remove volumes
- `ce persistent status` — show running state

Key points:
- docker-compose.yml is fully generated — no template, no hand-editing
- `config` handles everything Docker Compose supports: image, build, ports, volumes, healthchecks, deploy, networks, etc.
- `environment:` block contains resolved secrets → `ce build` auto-adds the file to `.gitignore`
- If the compose file already exists but wasn't generated by ce, build errors out — delete or rename it first
- Named volumes and networks are auto-detected from service configs and emitted as top-level blocks
- If multiple contracts write conflicting values for the same var on the same service, ce warns
- Target vars are **runtime-only** — injected when the container starts, never baked into the Docker image
- Contracts with only `target` (no `location`) are skipped by `ce start` PM2
- See `examples/docker-compose/` for a full working example

## Component format

```ini
# env/components/database.env
[default]
HOST=localhost
PORT=5432
NAME=myapp_dev
URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${database.HOST}:${database.PORT}/${database.NAME}

[production]
HOST=db.prod.internal
NAME=myapp
```

## Component best practices

### One service, one file

Each component file should represent exactly one logical service or concern. Name it after the service: `postgres.env`, `redis.env`, `auth.env`, `stripe.env`.

**Good:**
```
env/components/
├── postgres.env      # 5-6 keys: HOST, PORT, USER, NAME, URL
├── redis.env         # 3-4 keys: HOST, PORT, URL
├── auth.env          # JWT_SECRET, SESSION_TTL, OAUTH_CLIENT_ID
├── stripe.env        # API_KEY, WEBHOOK_SECRET, PRICE_ID
└── networking.env    # DOMAIN, PROFILE_SUFFIX, BASE_URL
```

**Bad:**
```
env/components/
├── services.env      # 40 keys across postgres, redis, auth, stripe...
└── config.env        # everything else
```

### Keep files small

The whole point of components is small, focused chunks that are easy to read and compare across profiles. Each file should have a handful of keys — if you can't see `[default]` and `[production]` on the same screen, the file is too big.

When a component has profile sections (`[default]`, `[local]`, `[production]`), you need to be able to quickly scan what differs. A 5-key file makes this trivial. A 40-key file makes it impossible.

### Name files after what they configure, not who uses them

Name components after the service they configure (`postgres.env`), not the app that consumes them (`api-database.env`). Multiple contracts can reference the same component — `${postgres.URL}` works from any contract. If two apps use the same Postgres, they reference the same component.

### Assemble composite values in components

URLs, connection strings, and other composite values should be assembled in the component, not in contracts:

```ini
# postgres.env
[default]
HOST=localhost
PORT=5432
USER=${secrets.DB_USER}
PASSWORD=${secrets.DB_PASSWORD}
NAME=myapp_dev
URL=postgresql://${postgres.USER}:${postgres.PASSWORD}@${postgres.HOST}:${postgres.PORT}/${postgres.NAME}
```

Contracts then reference `${postgres.URL}` — one place to update the format.

### Service networking convention

Each service component should define how to reach it on the network. Use `networking.env` to provide the building blocks (`DOMAIN`, `PROFILE_SUFFIX`), and let each service assemble its own reachable address per profile.

```ini
# networking.env
[local]
DOMAIN=orb.local
PROJECT=myproject
PROFILE_SUFFIX=-local

[production]
DOMAIN=example.com
PROJECT=myproject
PROFILE_SUFFIX=
```

```ini
# redis.env
[default]
PORT=6379
ENDPOINT=redis${networking.PROFILE_SUFFIX}.${networking.PROJECT}.${networking.DOMAIN}
URL=redis://${redis.ENDPOINT}:${redis.PORT}

[production]
ENDPOINT=redis.${networking.PROJECT}.${networking.DOMAIN}
URL=redis://${redis.ENDPOINT}:${redis.PORT}
```

```ini
# postgres.env
[default]
PORT=5432
USERNAME=postgres
ENDPOINT=postgres${networking.PROFILE_SUFFIX}.${networking.PROJECT}.${networking.DOMAIN}
URL=postgresql://${postgres.USERNAME}:${secrets.DB_PASSWORD}@${postgres.ENDPOINT}:${postgres.PORT}/myapp

[production]
ENDPOINT=db.${networking.PROJECT}.${networking.DOMAIN}
```

Any contract that needs to reach Redis references `${redis.URL}` or `${redis.ENDPOINT}`. It doesn't know about suffixes, domains, or networking — the component handles that per profile.

This is a convention, not ce magic. ce does not rewrite environment values. Each component is responsible for defining how to reach itself in every environment.

## Anti-patterns to watch for

1. **Never assemble URLs in contracts** — composite values like `DATABASE_URL` belong in the component. Contracts should reference `${database.URL}`, not `${database.PROTOCOL}://${database.USER}@${database.HOST}:${database.PORT}/${database.NAME}`. If 5 contracts all build the same URL inline, that's 5 places to update when the format changes.
2. **Never hardcode values in contract `vars`** — every value in `vars` must be a `${component.KEY}` reference. Hardcoded values only go in `defaults` as static fallbacks (e.g., `"LOG_LEVEL": "info"`). A URL like `http://localhost:3665` in vars should be `${game-server.URL}` so it varies by profile. If you see a literal value in `vars`, it belongs in a component.
3. **Don't duplicate vars across contracts** — if multiple contracts need the same set of variables, extract them into a `*.vars.json` file and use `includeVars`. If they need the same assembled value, put it in a component. One source of truth, many consumers.
4. **Don't reference secrets directly in contracts** — secrets should be referenced in components (`${secrets.KEY}`), and contracts reference components (`${component.KEY}`). This keeps the value mapping clean — a component value might not always be secret, and the contract shouldn't care where the value comes from.
5. **Don't leave profiles underspecified** — every profile that gets built should produce a complete, working env. If `production.json` only overrides `database` but the app also needs production `blockchain` and `game-server` values, the build will silently use `[default]` values for those. Audit profiles to ensure all components have appropriate section overrides.
6. **Don't keep vestigial components** — if two components define the same service's config (e.g., `partykit.env` and `game-server.env` both defining HOST for the same server), merge them. One component per logical service.
7. **Document all secrets for onboarding** — if a secret exists only in `.env.secrets.local` with no counterpart in `.env.secrets.shared`, new developers can't build without manual setup. Every team secret should be in `.env.secrets.shared` (or the vault), with `.env.secrets.local` only for personal overrides.
8. **Don't leave deploy-time values blank** — if a component has keys like `DIAMOND_ADDRESS=` that must be populated after a deploy, document this in the component file with a comment and consider a post-deploy script that writes to the component or vault.
9. **Don't manually source env in Docker** — use a `target` contract to write vars into docker-compose.yml's `environment:` block. Don't copy composable.env into the container or source .env files in entrypoints — that risks baking secrets into image layers. The `target` approach keeps secrets at runtime only.
10. **Don't hand-edit generated docker-compose.yml** — the compose file is a build artifact generated by `ce build`. If you need to change service config, update the contract's `target.config`. If you need to change env vars, update the contract's `vars` or the underlying component. `ce build` auto-gitignores the file since it contains secrets.

## When helping the user

1. **Scaffolding**: Use `ce init` for new projects. It creates `ce.json` and the directory structure.
2. **Debugging builds**: Run `ce build` and read error output. Missing vars usually mean a component is missing a key or a contract reference is wrong.
3. **Adding a service**: Create a `.contract.json` with `vars` mapping what the service needs to component keys.
4. **Adding a component**: Create a `.env` file in `env/components/` with `[default]` section. It's auto-discovered.
5. **Secrets**: Use `ce vault set KEY=VALUE` to encrypt. Reference with `${secrets.KEY}` in components — never in contracts directly.
6. **Cross-component refs**: Components can reference each other: `${database.HOST}` in a component resolves from the database component.
7. **Custom env dir**: Set `envDir` in `ce.json` if the project doesn't use the default `env/` path.
8. **Default profile**: Set `defaultProfile` in `ce.json` so the team doesn't need `--profile` on every command.
9. **Deciding where a value goes**: Is it secret? → `.env.secrets.shared`. Is it personal? → `.env.secrets.local` or `.env.local`. Is it neither? → directly in a component file (versioned).
10. **Docker Compose services**: Use `target` instead of `location` in the contract. Set `type: "docker-compose"`, point `file` to the compose file, and `service` to the service name. Gitignore the compose file since it will contain resolved secrets.
