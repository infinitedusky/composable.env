---
name: composable-env
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
pnpm ce env:build          # builds .env.local in apps/api/
pnpm ce profile:list       # shows components, profiles, contracts
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

| Command | Alias | Purpose |
|---------|-------|---------|
| `pnpm ce init` | — | Scaffold env/ directory and ce.json. `--scaffold docker` adds Docker + Next.js + VitePress setup. `--scaffold vitepress` for VitePress only. |
| `pnpm ce scaffold:sync` | — | Re-run scaffold (reads `scaffold` type from ce.json). Creates missing files and re-generates Dockerfiles to pick up new app contracts. Never overwrites user customizations to non-generated files. |
| `pnpm ce env:build <profile>` | `pnpm ce build <profile>` | Build .env files for a single profile (required argument). If docker-compose targets exist, compose file includes all profiles. Pass `--serve [services...]` to apply serve config overrides. |
| `pnpm ce env:build:all` | `pnpm ce build:all` | Build .env files for all profiles. |
| `pnpm ce profile:list` | `pnpm ce p:list` | Show components, profiles, contracts |
| `pnpm ce pm2:start [profile]` | `pnpm ce start` | Build env + launch PM2 for contracts with `target.type: "pm2"` (or legacy `dev` field) |
| `pnpm ce dc:up [profile]` | `pnpm ce up` | `docker compose --profile X down && up -d --build --remove-orphans`, then prune dangling images and build cache older than 24h. Before bringing services up, runs a pre-flight check for host port conflicts against other running compose projects — if another project is already publishing one of this project's host ports (commonly :80/:443 when running two proxy-equipped stacks), prints the conflicting container/project and exits with instructions to stop the other project first. Flags: `--no-cache` (force full rebuild), `--serve [services...]` (host-side build then run serve config). Does NOT auto-run env:build — run that separately if you changed env files. |
| `pnpm ce dc:down [profile]` | `pnpm ce down` | Stop Docker Compose services for a profile (`-v` to also remove volumes) |
| `pnpm ce dc:logs [profile]` | `pnpm ce logs` | Tail Docker Compose logs (`--service X` for one service) |
| `pnpm ce dc:ps [profile]` | `pnpm ce ps` | Show Docker Compose service status |
| `pnpm ce persistent:up` | — | Start persistent services (detached) |
| `pnpm ce persistent:down` | — | Stop persistent services (preserves volumes) |
| `pnpm ce persistent:destroy` | — | Stop persistent services and remove volumes |
| `pnpm ce persistent:status` | — | Show persistent service status |
| `pnpm ce vault <subcommand>` | — | Optional encrypted secrets. Subcommands: `init`, `set <key> <value>`, `get <key>`, `ls`, `add`, `remove`, `recipients` |
| `pnpm ce migrate` | — | Convert legacy format to vars format |
| `pnpm ce add-skill` | — | Install Claude Code skill |
| `pnpm ce uninstall` | — | Remove all ce artifacts |

## ce.json

```json
{
  "envDir": "env",
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "suffix": "-local",
      "domain": "myproject.orb.local",
      "tls": true
    },
    "production": {
      "suffix": "",
      "domain": "myproject.com",
      "override": {
        "admin": { "suffix": "", "domain": "admin.myproject.com" }
      }
    }
  }
}
```

- `envDir` — custom env directory (default: `"env"`)
- `defaultProfile` — default when no `--profile` flag
- `scaffold` — set automatically by `ce init --scaffold <type>`. Tells `scaffold:sync` which template to re-run.
- `profiles` — per-profile config:
  - `suffix` — compose service name suffix (e.g. `"-local"`, `""`, `"-stg"`)
  - `domain` — used for auto-generated `${service.*.address}`. If it ends in `.orb.local`, the first segment becomes the docker-compose project name (so OrbStack DNS matches what ce resolves).
  - `tls` — auto-generate mkcert certs, inject into all containers, run Caddy on :443/:80 (local dev only).
  - `proxy` — reverse-proxy config file format: `"nginx"` (default), `"caddy"`, or `"both"`. Controls what gets emitted alongside `docker-compose.yml` from contracts with `target.subdomain`. Caddy is useful for local dev when you want a single in-network reverse proxy that re-resolves Docker DNS per request (avoids OrbStack's stale-IP cache after container restarts). nginx is what most production environments use. `"both"` emits both side by side.
  - `tlsInternal` — when `true`, the generated Caddyfile emits `tls internal` inside each vhost so Caddy forces its internal CA regardless of domain. Needed for local-dev TLDs other than `.local`/`.localhost` (e.g. `.test`, `.dev`), where Caddy would otherwise try Let's Encrypt and fail because there's no public DNS. Leave unset for `.local` domains — Caddy's default already does the right thing there.
  - `override` — per-service suffix/domain overrides (e.g. `"admin": { "suffix": "" }` keeps admin unsuffixed in this profile).
- Profile resolution: `--profile` flag > `CE_PROFILE` env var (legacy: `CENV_PROFILE`) > `ce.json defaultProfile` > `"default"`

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
  "target": {
    "type": "pm2",
    "command": "pnpm dev",
    "label": "API Server"
  }
}
```

- Left side = app variable name (what the service sees)
- Right side = **always** a `${component.KEY}` reference. Contracts only reference components, never secrets directly. Secrets flow through components (`${secrets.KEY}` in a component, `${component.KEY}` in a contract).
- `defaults` is the **only** place for hardcoded values in a contract — static fallbacks like `LOG_LEVEL=info`. Everything in `vars` should be a `${component.KEY}` reference so values vary by profile.
- `defaults` provides fallbacks for unresolvable vars
- `target` declares the runtime, if any. `target.type: "docker-compose"` for Docker (full schema below), or `target.type: "pm2"` for PM2. Without a target, the contract just writes an env file — no process gets started. This is the right shape for env-only contracts (datadog, observability extensions, etc.).
- PM2 target shape: `{ "type": "pm2", "command": "pnpm dev", "label": "API" (optional), "cwd": "apps/api" (optional, defaults to location) }`. Use this instead of the legacy `dev` field for new contracts.
- `dev` (legacy) still works as a shortcut for a PM2 target. Equivalent to `target: { type: "pm2", ...dev }`. Use `target.type: "pm2"` going forward — `dev` will be removed in v2.
- `location` accepts: `"apps/api"` (relative to project root, default), `"/abs/path"` (absolute), or `"~/foo"` (`~` expands to `$HOME`). Use absolute or `~` paths to write env files outside the project tree (e.g., to a tool's config directory).
- `outputs` — optional map of profile name → output filename or path. When set, writes `${location}/${outputs[profile]}` instead of the default `${location}/.env.${profile}`. Profile names not in the map fall back to the default. The output value can be relative (joined with `location`), absolute, or `~`-prefixed. Useful for tools that expect specific filenames like `t.cyux.xy.env` or `service.env.prod`.
- `onlyProfiles` — optional array of ce profile names. If set, the contract is only included when building one of those profiles. Useful for dev-only services (log aggregators, debug tools) that shouldn't exist in production builds
- `includeVars` — array of var set names to inherit. Resolves `*.vars.json` files from `env/contracts/`. Merged left-to-right, contract's own vars win on conflict
- `default` — optional string (e.g., `".env"`, `".env.base"`). Controls how the default profile is written for this contract:
  - If a `default` profile exists: writes to this filename instead of `.env.default`
  - If no `default` profile exists: builds using only `[default]` sections from components, skips unresolvable vars, writes to this filename
- `ignoreDefault` — optional boolean. If `true`, skip the default profile entirely for this contract (no `.env.default` written even if a default profile exists)
- `persistent` — optional boolean (docker-compose targets only). If `true`, this service goes into a separate `docker-compose.persistent.yml` file. Used for databases, caches, and other long-lived containers managed via `pnpm ce persistent:*` commands so they survive normal `dc:up` rebuild cycles.
- `serve` — optional. Used by `dc:up --serve <name>` to run a host-side build then start the container with overrides. Shape: `{ "build": "turbo build --filter=@org/api", "config": { "build": { "dockerfile": "..." }, "volumes": [] } }`. The `build` command runs on the host (with that contract's env vars loaded). `config` overrides `target.config` for the rebuilt compose file. ce auto-sets `NODE_ENV=production` for served services.

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
  }
}
```

Multiple contracts targeting the same compose service are **additive** — both `config` (arrays concatenated, objects merged) and `vars` (merged) accumulate. The relationship between `location` and `target` controls what gets generated:

- `location` only, no `target` → writes `.env.{profile}`. No process runs. (Datadog-style env-only contracts.)
- `target.type: "docker-compose"` only → writes into docker-compose.yml. No `.env` file.
- `target.type: "docker-compose"` + `location` → writes both: `.env.{profile}` for local tooling AND the compose service.
- `target.type: "pm2"` (requires `location`) → writes `.env.{profile}` and PM2 spawns the command from that directory.

Today a contract has at most one `target`. To run the same contract via PM2 *and* Docker, add a legacy `dev` field as a sibling to the docker-compose target. v2 will introduce `targets: []` arrays for first-class multi-runtime support — see `docs/planning/targets-array-v2/`.

### Compose file output: two shapes

**Default — single compose file with all profiles** (`target.file: "docker-compose.yml"`):
ce writes one file containing every profile's services, each variant suffixed (`admin-server-local`, `admin-server-test`) and tagged with `profiles: [X]` arrays. `docker compose --profile X up` selects at runtime. Profile suffixes MUST be unique because the `services:` map is flat — two profiles with the same suffix would collide on service names.

**Per-profile files** (`target.file: "docker-compose.{profile}.yml"`):
The `{profile}` placeholder splits output into one file per profile — `docker-compose.local.yml`, `docker-compose.test.yml`, `docker-compose.production.yml`. Each file is its own namespace, so service names can be clean (`admin-server` in every file, no suffix) and profile suffixes can be empty across the board. `pnpm ce dc:up <profile>` reads the matching file. No `--profile` flag needed at the Docker level since each file IS the profile selector. Use this shape when:
- You want production service names to match dev (no `-local` / `-test` suffix discipline)
- Profiles correspond to distinct environments you run one-at-a-time
- You'd rather have multiple compose files than one big multi-profile one

Switch shape per project by changing the `target.file` value in your contracts. The two shapes can coexist if some contracts use the placeholder and others don't.

#### Single-file shape — the YAML it generates

When `pnpm ce env:build` detects target contracts, it builds **all profiles** (from `env/profiles/*.json` — not component sections) into one compose file. Shared Docker config (image, ports, volumes) goes into `x-` YAML anchor blocks. Per-profile variants use `<<: *anchor` merge and Docker Compose `profiles:` arrays:

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

Switch environments without rebuilding: `pnpm ce dc:up local` vs `pnpm ce dc:up production`.

Every service is always profiled — names are always `{service}-{suffix}` (e.g., `redis-local`). No bare `docker compose up`; always use `--profile`. `onlyProfiles` on contracts controls which profiles include that contract, and `depends_on` references are rewritten to match profiled service names.

**Hostnames are a component concern.** ce does not rewrite environment values to add profile suffixes — that's handled by the `networking.env` component. If a service needs to reference another service's profiled hostname, build it in the component using `${networking.PROFILE_SUFFIX}`:

> **Breaking change note (v1.8):** Prior to v1.8, ce automatically scanned all environment values in Docker Compose target output and rewrote any value matching a service name to include the profile suffix (e.g., `redis` → `redis-local`). This was removed because it caused false rewrites — values like `NEO4J_USERNAME=neo4j` were rewritten to `neo4j-local` because `neo4j` matched a service name. The replacement is auto-generated `${service.<name>.host}` and `${service.<name>.address}` vars — configure `domain` in your `ce.json` profiles and reference these explicitly in components. See "Service networking with auto-generated vars" in best practices. `depends_on` rewriting is unaffected — ce still rewrites those to match profiled service names.

```ini
# networking.env
[local]
PROFILE_SUFFIX=-local

# game-server.env
[default]
HOST=game-server${networking.PROFILE_SUFFIX}
```

`pnpm ce env:build` (no profile flag) writes `.env.{profile}` for every profile. `pnpm ce env:build --profile X` writes only `.env.X` but the compose file still includes all profiles.

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
- `pnpm ce persistent:up` — start persistent services (detached)
- `pnpm ce persistent:down` — stop (preserves volumes)
- `pnpm ce persistent:destroy` — stop and remove volumes
- `pnpm ce persistent:status` — show running state

Key points:
- docker-compose.yml is fully generated — no template, no hand-editing
- `config` handles everything Docker Compose supports: image, build, ports, volumes, healthchecks, deploy, networks, etc.
- `environment:` block contains resolved secrets → `pnpm ce env:build` auto-adds the file to `.gitignore`
- If the compose file already exists but wasn't generated by ce, `pnpm ce env:build` errors out — delete or rename it first
- Named volumes and networks are auto-detected from service configs and emitted as top-level blocks
- If multiple contracts write conflicting values for the same var on the same service, `pnpm ce env:build` warns
- Target vars are **runtime-only** — injected when the container starts, never baked into the Docker image
- Contracts with only `target` (no `location`) are skipped by `pnpm ce pm2:start`
- See `examples/docker-compose/` for a full working example

## Reverse proxy — nginx or Caddy config generation

Contracts with `subdomain` on their target auto-generate a reverse-proxy config per profile. Requires `domain` in `ce.json` profiles. The emitter is selected via the profile's `proxy` field — `"nginx"` (default), `"caddy"`, or `"both"`.

```json
{
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "portainer",
    "subdomain": "portainer",
    "config": { "image": "portainer/portainer-ce:latest", "ports": ["9000:9000"] }
  }
}
```

**nginx** (`proxy: "nginx"`, default): generates `nginx.{profile}.conf` (or `nginx.conf` if only one profile emits) with `server_name portainer.{domain}` proxying to the container port. Includes WebSocket upgrade headers. Auto-gitignored. Typical deployment: copy to `/etc/nginx/sites-enabled/` on the production host.

**Caddy** (`proxy: "caddy"`): generates `Caddyfile.{profile}` (or `Caddyfile`) with `reverse_proxy {service}{suffix}:{port}` site blocks. Caddy auto-issues HTTPS via its internal CA (run `caddy trust` once per dev machine) and re-resolves Docker DNS per request — handy for local dev when you want to bypass OrbStack's stale-IP cache by running Caddy as a docker-compose service joined to the same network. Auto-gitignored. For DNS resolution without `/etc/hosts` edits, run `./scripts/dev/setup-dns.sh` (scaffolded by `ce init --scaffold docker`) — it configures dnsmasq + `/etc/resolver/{tld}` once per machine so any `*.{your-domain}` hostname resolves to 127.0.0.1.

For non-`.local` local-dev TLDs (`.test`, `.dev`, etc.), set `tlsInternal: true` on the profile — the Caddyfile then includes `tls internal` per vhost, forcing Caddy's internal CA instead of the Let's Encrypt attempt that fails without public DNS. `.local` profiles don't need it; Caddy's default already issues an internal cert for that TLD.

When `proxy: "caddy"` is set AND any contract has `target.subdomain`, ce **auto-injects a Caddy container** (`caddy:2-alpine`) into the same `docker-compose.yml`. It mounts the generated Caddyfile, publishes :80 and :443 on the host, and persists Caddy's internal CA in named volumes. No manual `caddy.contract.json` needed. If you write your own `caddy.contract.json` (e.g., for a custom image or extra mounts), your contract wins — ce skips the injection.

**both** emits both files. Use during a transition from one to the other, or when local dev uses Caddy but production uses nginx.

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

### Service networking with auto-generated vars

When `ce.json` has profile configs with `domain`, ce auto-generates a `service` pseudo-component with networking vars for every service that has a Docker Compose `target`. These are available as `${service.<name>.<property>}` in any component or contract.

**ce.json config:**

```json
{
  "profiles": {
    "local": {
      "suffix": "-local",
      "domain": "myproject.orb.local",
      "override": {
        "admin": { "suffix": "" }
      }
    },
    "production": {
      "suffix": "",
      "domain": "myproject.com"
    }
  }
}
```

**Auto-generated vars** (for a `game-server` service in `local` profile):

| Reference | Resolves to | Description |
|-----------|-------------|-------------|
| `${service.game-server.host}` | `game-server-local` | Container name (service + suffix) |
| `${service.game-server.address}` | `game-server-local.myproject.orb.local` | Full reachable address |
| `${service.game-server.suffix}` | `-local` | Profile suffix |
| `${service.game-server.domain}` | `myproject.orb.local` | Domain for this profile |

**Usage in components:**

```ini
# game-server.env
[default]
PORT=3665
URL=${service.game-server.protocol}://${service.game-server.address}:${game-server.PORT}
```

**Per-service overrides:** The `override` map lets specific services have different suffixes or domains. In the example above, `admin` has no suffix in local — `${service.admin.host}` resolves to `admin`, not `admin-local`.

Components can still override service vars by defining the same key explicitly — the auto-generated values are defaults that components and contracts build on top of.

**Proxy-aware addresses:** When the profile has `proxy: "caddy"` (or `"both"`) AND a contract declares `target.subdomain`, the auto-generated `address` and `protocol` switch to the proxy's public vhost — not the Docker DNS form. This matters for browser-facing env vars like `NEXT_PUBLIC_AUTH_BASE_URL` that need the URL the *browser* uses, not the URL one container uses to reach another:

| Setup | `${service.auth-server.address}` | `${service.auth-server.protocol}` |
|-------|---------|---------|
| `proxy` not set | `auth-server-local.numero.local` (Docker DNS) | `http` |
| `proxy: "caddy"` + `subdomain: "auth"` | `auth.numero.local` (Caddy vhost) | `https` |
| `proxy: "caddy"`, contract has no `subdomain` | `auth-server-local.numero.local` (internal-only service, not proxy-routable) | `http` |

`${service.<name>.host}` always returns the Docker DNS form regardless of proxy config — that's the name container-to-container traffic uses on the internal network, which doesn't go through the proxy. So a typical pair:

```ini
# Internal call (one container → another, bypasses Caddy)
INTERNAL_AUTH_URL=http://${service.auth-server.host}:${auth-server.PORT}

# Browser-facing URL (goes through Caddy, https + public vhost)
NEXT_PUBLIC_AUTH_BASE_URL=${service.auth-server.protocol}://${service.auth-server.address}
```

### Profile-global vars (`${profile.*}`)

Alongside `${service.<name>.*}`, ce auto-injects a `${profile.*}` namespace for **profile-global** primitives — values that don't depend on which service you're configuring:

| Reference | Returns |
|-----------|---------|
| `${profile.name}` | Current profile name (`"local"`, `"staging"`, `"production"`) |
| `${profile.suffix}` | The profile's `suffix` from `ce.json` (`"-local"`, `"-stg"`, `""`) |
| `${profile.domain}` | The profile's `domain` from `ce.json` (`"numero.local"`, `"chitin.casino"`) |
| `${profile.protocol}` | `"https"` when `tls: true`, otherwise `"http"` |

Use these in components and contracts when the value applies to the whole profile, not a specific service. Example:

```ini
# auth.env
COOKIE_DOMAIN=${profile.domain}
```

```json
// vars/platform-base.vars.json
{
  "vars": {
    "NEXT_PUBLIC_DOMAIN": "${profile.domain}",
    "NEXT_PUBLIC_PROFILE_SUFFIX": "${profile.suffix}",
    "NODE_ENV": "${profile.name}"
  }
}
```

This replaces the common pattern of hand-rolling a `networking.env` component with `DOMAIN=` / `PROFILE_SUFFIX=` per profile section — the data already lives in `ce.json`, and `${profile.*}` exposes it directly.

### Automatic TLS with mkcert

When a profile has `tls: true` and a `domain`, `pnpm ce dc:up` automatically:

1. **Generates mkcert certs** — wildcard cert for `*.{domain}` in `.certs/{domain}/`
2. **Mounts certs into containers** — adds `.certs/{domain}:/app/.certs:ro` volume to all target services
3. **Sets `NODE_EXTRA_CA_CERTS`** — so containers trust the local CA for service-to-service HTTPS calls
4. **Sets `CE_TLS_PORT`** on all services — signals the entrypoint to start Caddy
5. **Starts Caddy TLS proxy** — `:443` serves HTTPS (reverse proxies to app on its normal PORT), `:80` redirects HTTP to HTTPS

The app keeps its original PORT — no shifting. Caddy runs on well-known ports (443/80). OrbStack routes `https://service.domain` to `:443` and `http://` to `:80`. Matches production (load balancer on 443/80).

Dev Dockerfiles include `RUN apk add --no-cache caddy` (standard package, no custom build). The app-entrypoint.sh generates a Caddyfile at runtime and starts Caddy before the app. This is local dev only — production profiles without `tls: true` don't get any of this.

Prerequisites: `brew install mkcert && mkcert -install`

The `.certs/` directory is auto-gitignored. Certs are only generated once — subsequent `dc:up` calls skip cert generation if they already exist.

Use `${service.*.protocol}` in components to get `https` when `tls: true`, `http` otherwise. This way the same component works for both TLS and non-TLS profiles.

## Turbo + Docker: env var passthrough

In monorepos using turbo + Docker, Docker Compose `environment:` vars are set on the container but turbo strips them from child processes. If your Dockerfile runs `CMD ["pnpm", "dev"]` and that invokes turbo, the app process never sees the env vars — even though `docker exec env` shows them.

**The fix:** Use an entrypoint script that calls `pnpm --filter <app>` directly, bypassing turbo. The contract's `command` field passes the pnpm filter name as the argument.

`docker/app-entrypoint.sh` (generated by `pnpm ce init --scaffold docker`):

```sh
#!/bin/sh
APP_FILTER="$1"
if [ "$NODE_ENV" = "production" ]; then
  pnpm --filter "$APP_FILTER" build
  exec pnpm --filter "$APP_FILTER" start
else
  exec pnpm --filter "$APP_FILTER" dev
fi
```

Dockerfiles use `ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]`. Contracts pass the app name via `command` in `target.config`:

```json
{
  "target": {
    "config": {
      "command": "@myorg/myapp"
    }
  }
}
```

The entrypoint receives `@myorg/myapp` as `$1` and runs `pnpm --filter @myorg/myapp dev` (or `build` + `start` in production). Env vars pass through because turbo is never invoked.

### Workspace dep installation: wholesale COPY

The dev Dockerfiles (`Dockerfile.nextdev`, `Dockerfile.vitepressdev`) install workspace dependencies via wholesale COPY of `apps/` and `packages/` before `pnpm install --frozen-lockfile`. This works with every pnpm workspace shape, including `dependenciesMeta.injected` deps that other approaches (notably `turbo prune --docker`) can't serialize.

Trade-off: changing any file in `apps/` or `packages/` invalidates the install layer for every service. For projects with many services and frequent package edits, this can mean longer rebuild times. If your project doesn't use injected deps and the cache invalidation hurts, replace the scaffolded Dockerfile with a tighter pattern (per-app COPY enumeration or a tool that handles your workspace shape).

## Anti-patterns to watch for

1. **Never hardcode values in contract `vars`** — every value in `vars` must be a `${component.KEY}` reference. Hardcoded values only go in `defaults` as static fallbacks (e.g., `"LOG_LEVEL": "info"`). A URL like `http://localhost:3665` in vars should be `${game-server.URL}` so it varies by profile. If you see a literal value in `vars`, it belongs in a component.
2. **Don't duplicate vars across contracts** — if multiple contracts need the same set of variables, extract them into a `*.vars.json` file and use `includeVars`. If they need the same assembled value, put it in a component. One source of truth, many consumers.
3. **Don't reference secrets directly in contracts** — secrets should be referenced in components (`${secrets.KEY}`), and contracts reference components (`${component.KEY}`). This keeps the value mapping clean — a component value might not always be secret, and the contract shouldn't care where the value comes from.
4. **Don't leave profiles underspecified** — every profile that gets built should produce a complete, working env. If `production.json` only overrides `database` but the app also needs production `blockchain` and `game-server` values, the build will silently use `[default]` values for those. Audit profiles to ensure all components have appropriate section overrides.
5. **Don't keep vestigial components** — if two components define the same service's config (e.g., `partykit.env` and `game-server.env` both defining HOST for the same server), merge them. One component per logical service.
6. **Document all secrets for onboarding** — if a secret exists only in `.env.secrets.local` with no counterpart in `.env.secrets.shared`, new developers can't build without manual setup. Every team secret should be in `.env.secrets.shared` (or the vault), with `.env.secrets.local` only for personal overrides.
7. **Don't leave deploy-time values blank** — if a component has keys like `DIAMOND_ADDRESS=` that must be populated after a deploy, document this in the component file with a comment and consider a post-deploy script that writes to the component or vault.
8. **Don't manually source env in Docker** — use a `target` contract to write vars into docker-compose.yml's `environment:` block. Don't copy composable.env into the container or source .env files in entrypoints — that risks baking secrets into image layers. The `target` approach keeps secrets at runtime only.
9. **Don't hand-edit generated docker-compose.yml** — the compose file is a build artifact generated by `pnpm ce env:build`. If you need to change service config, update the contract's `target.config`. If you need to change env vars, update the contract's `vars` or the underlying component. `pnpm ce env:build` auto-gitignores the file since it contains secrets.

## When helping the user

1. **Scaffolding**: Use `pnpm ce init` for new projects. It creates `ce.json` and the directory structure.
2. **Debugging builds**: Run `pnpm ce env:build` and read error output. Missing vars usually mean a component is missing a key or a contract reference is wrong.
3. **Adding a service**: Create a `.contract.json` with `vars` mapping what the service needs to component keys.
4. **Adding a component**: Create a `.env` file in `env/components/` with `[default]` section. It's auto-discovered.
5. **Secrets**: Use `pnpm ce vault set KEY=VALUE` to encrypt. Reference with `${secrets.KEY}` in components — never in contracts directly.
6. **Cross-component refs**: Components can reference each other: `${database.HOST}` in a component resolves from the database component.
7. **Custom env dir**: Set `envDir` in `ce.json` if the project doesn't use the default `env/` path.
8. **Default profile**: Set `defaultProfile` in `ce.json` so the team doesn't need `--profile` on every command.
9. **Deciding where a value goes**: Is it secret? → `.env.secrets.shared`. Is it personal? → `.env.secrets.local` or `.env.local`. Is it neither? → directly in a component file (versioned).
10. **Docker Compose services**: Use `target` instead of `location` in the contract. Set `type: "docker-compose"`, point `file` to the compose file, and `service` to the service name. Gitignore the compose file since it will contain resolved secrets.
11. **Starting Docker services**: Use `pnpm ce dc:up local` (builds env, then docker compose down + up --build). Use `pnpm ce dc:logs local` to tail logs, `pnpm ce dc:ps local` for status.
12. **Persistent services**: Use `pnpm ce persistent:up` to start databases/caches, `pnpm ce persistent:status` to check them.
