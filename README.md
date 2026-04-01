# composable.env

> Build `.env` files and `docker-compose.yml` for every service from reusable **components**, **profiles**, and **contracts**.

Like CSS for environment variables. Define once, compose everywhere, generate Docker Compose files with resolved secrets. Version the source of truth, gitignore the outputs.

```bash
npm install -D composable.env
```

Requires Node.js 18+. The CLI command is `ce`.

---

## Table of contents

- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
  - [Components](#components)
  - [Secrets](#secrets)
  - [Profiles](#profiles)
  - [Contracts](#contracts)
- [Docker Compose](#docker-compose)
  - [Targeting a compose file](#targeting-a-compose-file)
  - [Multi-profile output](#multi-profile-output)
  - [profileOverrides](#profileoverrides)
  - [Persistent services](#persistent-services)
- [Service networking](#service-networking)
- [Var sets — shared variable bundles](#var-sets--shared-variable-bundles)
- [Value layers — who is each file for?](#value-layers--who-is-each-file-for)
- [Monorepo / Turborepo setup](#monorepo--turborepo-setup)
- [CLI reference](#cli-reference)
- [ce.json reference](#cejson-reference)
- [How it works](#how-it-works)
- [Beta features](#beta-features)
  - [Vault — encrypted secrets](#vault--encrypted-secrets)
  - [PM2 execution — ce start](#pm2-execution--ce-start)
- [Programmatic API](#programmatic-api)
- [Migration from v0.5.x](#migration-from-v05x)

---

## Quick start

### 1. Scaffold

```bash
ce init
```

Creates `ce.json` and the `env/` directory with `components/`, `profiles/`, `contracts/`, and secret/override files.

For Docker-based projects with Next.js apps:

```bash
ce init --scaffold docker
```

This also creates profiles, Dockerfiles, networking components, and a VitePress docs setup. See `ce init --help` for all options.

### 2. Create a component

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

### 3. Create a profile

```json
// env/profiles/local.json
{ "name": "local", "description": "Local development" }
```

Even an empty profile defines "local" as a valid profile name.

### 4. Create a contract

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

### 5. Add secrets

```ini
# env/.env.secrets.shared — distribute to team, never commit
DB_PASSWORD=local-dev-password
```

### 6. Build

```bash
ce build local                  # builds .env.local
ce build production             # builds .env.production
ce build:all                    # builds all profiles
```

Each contract generates a `.env.{profile}` file at its `location`.

### 7. Run with env loaded

```bash
ce run -- npm start
ce run --profile production -- npm start
```

If the `.env` file doesn't exist yet, `ce run` auto-builds it.

---

## Core concepts

### Components

INI files in `env/components/`. Each section maps to a profile. Auto-discovered from the filesystem — no registration needed.

```ini
# env/components/database.env
[default]
HOST=localhost
PORT=5432
NAME=myapp_dev
URL=postgresql://${database.USER}:${database.PASSWORD}@${database.HOST}:${database.PORT}/${database.NAME}

[production]
HOST=db.prod.internal
NAME=myapp
```

- `[default]` is required — provides base values
- Named sections (`[production]`, `[staging]`) override `[default]` for that profile
- Components reference secrets with `${secrets.KEY}`
- Components reference each other with `${component.KEY}` — e.g., `${redis.HOST}`

**Keep components small and focused.** One file per logical service: `postgres.env`, `redis.env`, `auth.env`, `stripe.env`. If you can't see `[default]` and `[production]` on the same screen, the file is too big. The whole point is small chunks that are easy to compare across profiles.

### Secrets

Two files, separated by audience:

| File | Purpose | Committed? |
|------|---------|-----------|
| `env/.env.secrets.shared` | Team secrets (DB passwords, API keys) | No — distributed manually or via vault |
| `env/.env.secrets.local` | Personal secret overrides | No (gitignored) |

```ini
# env/.env.secrets.shared
DB_USER=postgres
DB_PASSWORD=team-shared-password

# env/.env.secrets.local — overrides for this developer only
DB_PASSWORD=my-personal-password
```

Components reference secrets with `${secrets.KEY}`. Contracts reference components — **never secrets directly**. The flow is always:

```
secrets → components → contracts → output
```

### Profiles

JSON files in `env/profiles/` that define environments. Profiles are defined **only** by the presence of a `.json` file — component sections alone don't create profiles.

```json
// env/profiles/production.json
{
  "name": "Production",
  "components": {
    "database": "production"
  }
}
```

```json
// env/profiles/staging.json
{
  "name": "Staging",
  "extends": "production",
  "components": {
    "database": "staging"
  }
}
```

- `extends` inherits from another profile
- `components` maps component names to section names when you need explicit overrides
- Without a profile JSON, `ce build` uses `[default]` sections only
- A bare `{ "name": "local" }` is valid — it just uses `[default]` + `[local]` sections

### Contracts

JSON files that declare what variables a service needs. Each contract maps app variable names to component references.

```json
// env/contracts/api.contract.json
{
  "name": "api",
  "location": "apps/api",
  "vars": {
    "DATABASE_URL": "${database.URL}",
    "REDIS_URL": "${redis.URL}",
    "JWT_SECRET": "${auth.JWT_SECRET}"
  },
  "defaults": {
    "LOG_LEVEL": "info"
  }
}
```

| Field | Purpose |
|-------|---------|
| `name` | Service identifier |
| `location` | Where to write the `.env.{profile}` file |
| `target` | Alternative: write into a docker-compose.yml (see [Docker Compose](#docker-compose)) |
| `vars` | Maps app variable names → `${component.KEY}` references |
| `defaults` | Static fallback values for unresolved vars |
| `includeVars` | Inherit shared var sets (see [Var sets](#var-sets--shared-variable-bundles)) |
| `onlyProfiles` | Only include this contract for these profiles |
| `dev` | Process config for `ce start` (see [PM2 execution](#pm2-execution--ce-start)) |
| `persistent` | Route to `docker-compose.persistent.yml` (see [Persistent services](#persistent-services)) |

**Rules for `vars`:**
- Every value in `vars` should be a `${component.KEY}` reference
- Hardcoded values only go in `defaults` — static fallbacks like `LOG_LEVEL=info`
- Never reference secrets directly in contracts — secrets flow through components

A contract can have `location`, `target`, or both:
- `location` only → writes `.env.{profile}` (local dev)
- `target` only → writes into docker-compose.yml (Docker only)
- Both → writes to both from the same contract

---

## Docker Compose

Contracts can target a `docker-compose.yml` file. The compose file is a **build artifact** — fully generated by `ce build`, gitignored, and contains resolved secrets. Contracts are the versioned source of truth.

### Targeting a compose file

```json
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
  "vars": {
    "PORT": "${api.PORT}",
    "DATABASE_URL": "${database.URL}"
  }
}
```

- `config` defines the full Docker service (image, ports, volumes, healthchecks, etc.)
- `vars` become the `environment:` block with resolved values
- Multiple contracts can target the same service — `config` and `vars` merge additively
- `ce build` auto-adds the compose file to `.gitignore`
- If the file exists but wasn't generated by ce, build errors — delete it first
- Named volumes and networks are auto-detected and emitted as top-level blocks

### Multi-profile output

When contracts have targets, `ce build` generates **all profiles** into one compose file using YAML anchors. Shared Docker config goes into `x-` blocks, per-profile variants use `<<: *anchor` merge:

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
```

Switch environments without rebuilding:

```bash
docker compose --profile local up
docker compose --profile production up
```

Every service is always profiled — names are `{service}{suffix}` (e.g., `app-local`). The suffix comes from your `ce.json` [profiles config](#cejson-reference). `depends_on` references are automatically rewritten to match profiled service names.

### profileOverrides

When local and production need different Docker config:

```json
{
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "poker",
    "config": {
      "build": { "context": ".", "dockerfile": "docker/Dockerfile.nextdev" },
      "volumes": ["./apps/poker:/app/apps/poker"],
      "command": "@numero/poker"
    },
    "profileOverrides": {
      "production": {
        "build": { "context": ".", "dockerfile": "docker/Dockerfile.nextprod" },
        "volumes": []
      }
    }
  }
}
```

- `config` is the base (goes into the YAML anchor)
- `profileOverrides` keys are profile names, values are partial overrides
- Merge is **shallow per top-level key** — `"volumes": []` replaces the entire array
- Unmentioned keys inherit from the base
- Use cases: remove volume mounts in production, different Dockerfile, different command

### Persistent services

Services that survive rebuild cycles (databases, caches) use `"persistent": true`:

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
      "volumes": ["pgdata:/var/lib/postgresql/data"]
    }
  },
  "vars": { "POSTGRES_PASSWORD": "${secrets.DB_PASSWORD}" }
}
```

Persistent contracts are written to `docker-compose.persistent.yml` instead of the main compose file.

```bash
ce persistent up        # start persistent services (detached)
ce persistent down      # stop (preserves volumes)
ce persistent destroy   # stop and remove volumes
ce persistent status    # show running state
```

Persistent is a **local dev concept** — in production, databases are typically managed services.

---

## Service networking

When your `ce.json` has profile configs with `domain`, ce auto-generates networking vars for every service with a Docker Compose target.

### ce.json profiles config

```json
{
  "profiles": {
    "local": {
      "suffix": "-local",
      "domain": "myproject.orb.local"
    },
    "production": {
      "suffix": "",
      "domain": "myproject.com"
    }
  }
}
```

### Auto-generated vars

For a `game-server` service in the `local` profile:

| Reference | Resolves to |
|-----------|-------------|
| `${service.game-server.host}` | `game-server-local` |
| `${service.game-server.address}` | `game-server-local.myproject.orb.local` |
| `${service.game-server.suffix}` | `-local` |
| `${service.game-server.domain}` | `myproject.orb.local` |
| `${service.default.suffix}` | `-local` |
| `${service.default.domain}` | `myproject.orb.local` |

### Usage in components

```ini
# game-server.env
[default]
PORT=3665
URL=http://${service.game-server.address}:${game-server.PORT}
```

### Per-service overrides

```json
{
  "profiles": {
    "local": {
      "suffix": "-local",
      "domain": "myproject.orb.local",
      "override": {
        "admin": { "suffix": "" }
      }
    }
  }
}
```

`${service.admin.host}` resolves to `admin` (no suffix), while all other services get `-local`.

We recommend [OrbStack](https://orbstack.dev/) for local Docker development — it provides automatic `.orb.local` DNS for containers, which maps directly to the `domain` config.

---

## Reverse proxy — nginx config generation

Contracts with a `subdomain` field on their target automatically generate an nginx config when `ce build` runs. The generated config routes `{subdomain}.{domain}` to the container's port.

### Add subdomain to a contract

```json
{
  "name": "portainer",
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "portainer",
    "subdomain": "portainer",
    "config": {
      "image": "portainer/portainer-ce:latest",
      "ports": ["9000:9000"]
    }
  },
  "vars": {}
}
```

### Generated output

`ce build` generates `nginx.{profile}.conf` (or `nginx.conf` if only one profile has a domain):

```nginx
# Generated by composable.env — DO NOT EDIT
# Profile: production

server {
    listen 80;
    server_name portainer.myproject.com;

    location / {
        proxy_pass http://portainer:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Deployment

On your VPS:

```bash
ce build production
sudo cp nginx.production.conf /etc/nginx/sites-enabled/myproject
sudo nginx -s reload
```

The nginx config is auto-gitignored (same as compose files). The port is extracted from the contract's `config.ports`. WebSocket upgrade headers are included by default.

---

## Var sets — shared variable bundles

When multiple contracts need the same variables, extract them into a var set:

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

Contracts inherit var sets with `includeVars`:

```json
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

Poker gets all 3 platform-base vars + its 2 own vars. Contract's own vars win on conflict.

- Var sets live in `env/contracts/` as `*.vars.json` files
- Var sets can chain — a var set can have its own `includeVars`
- Cycle detection prevents infinite loops
- Var sets support subdirectories: `includeVars: ["shared/platform-base"]` resolves to `env/contracts/shared/platform-base.vars.json`

---

## Value layers — who is each file for?

Files are organized by **audience**, not by environment:

| File | Sensitive? | Audience | In git? |
|------|-----------|----------|---------|
| `env/components/*.env` | No | Everyone | Yes |
| `env/.env.secrets.shared` | Yes | All devs | No — distributed manually or via vault |
| `env/.env.secrets.local` | Yes | One developer | No |
| `env/.env.local` | No | One developer | No |

**Mental model:**
- Shared, non-secret → component file (versioned)
- Shared, secret → `.env.secrets.shared` (distributed to team)
- Personal, secret → `.env.secrets.local`
- Personal, non-secret → `.env.local` (rarely needed)

---

## Monorepo / Turborepo setup

```bash
# At the monorepo root
npm install -D composable.env
ce init  # auto-detects turbo.json, adds env/** to globalDependencies
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `ce init` | Scaffold env/ directory and ce.json |
| `ce init --scaffold docker` | Full Docker + Next.js + VitePress setup |
| `ce build <profile>` | Build .env files for a single profile |
| `ce build:all` | Build .env files for all profiles |
| `ce list` | List components, profiles, contracts |
| `ce run [--profile name] -- <cmd>` | Load env and run a command (auto-builds) |
| `ce persistent up` | Start persistent Docker services |
| `ce persistent down` | Stop persistent services (preserves volumes) |
| `ce persistent destroy` | Stop and remove persistent volumes |
| `ce persistent status` | Show persistent service state |
| `ce migrate [--dry-run]` | Migrate from legacy format |
| `ce add-skill` | Install Claude Code skill |
| `ce uninstall [--all]` | Remove all ce artifacts |

### Profile resolution priority

`--profile` flag > `CE_PROFILE` env var > `ce.json defaultProfile` > `"default"`

---

## ce.json reference

```json
{
  "envDir": "env",
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "suffix": "-local",
      "domain": "myproject.orb.local",
      "override": {
        "admin": { "suffix": "", "domain": "admin.myproject.orb.local" }
      }
    },
    "staging": {
      "suffix": "-stg",
      "domain": "myproject.dev"
    },
    "production": {
      "suffix": "",
      "domain": "myproject.com"
    }
  }
}
```

| Field | Default | Purpose |
|-------|---------|---------|
| `envDir` | `"env"` | Relative path to the env config directory |
| `defaultProfile` | `"default"` | Profile when no `--profile` flag is set |
| `profiles` | — | Per-profile config for Docker service naming and networking |
| `profiles.{name}.suffix` | — | Appended to Docker service names (e.g., `-local`) |
| `profiles.{name}.domain` | — | Domain for auto-generated `${service.*}` vars |
| `profiles.{name}.override` | — | Per-service suffix/domain overrides |

---

## How it works

1. **Discover** all component files in `env/components/`
2. **Resolve** profile inheritance chain (e.g., `staging` extends `production`)
3. **Load secrets** from `.env.secrets.shared` + `.env.secrets.local`
4. **Generate** `${service.*}` vars from `ce.json` profiles config
5. **Compose** each component's sections: `[default]` + `[profileName]`
6. **Resolve** `${secrets.KEY}` references in components
7. **Resolve** `${component.KEY}` cross-references (multi-pass)
8. **Resolve** `${service.*}` networking references
9. **Layer** `.env.local` overrides
10. **Map** contract `vars` — resolve references from the component pool
11. **Apply** defaults for unresolved vars
12. **Write** `.env.{profile}` per contract location + `docker-compose.yml` per target

---

## Beta features

These features are functional but less battle-tested. APIs may change.

### Vault — encrypted secrets

> Requires: `npm install age-encryption sops-age @noble/curves @scure/base`

The vault encrypts secret values directly in `.env.secrets.shared` so the file can be committed safely. Uses [age](https://age-encryption.org/) encryption — no external service needed.

```bash
# Initialize
ce vault init --github your-username

# Store a secret
ce vault set DB_PASSWORD "s3cret-p@ssw0rd"
# → DB_PASSWORD=CENV_ENC[...] in .env.secrets.shared

# Read a secret
ce vault get DB_PASSWORD

# Add a team member (fetches their GitHub SSH keys)
ce vault add --github alice

# Remove a team member
ce vault remove alice

# List encrypted keys / recipients
ce vault ls
ce vault recipients
```

During build, `CENV_ENC[...]` values are decrypted transparently.

**Identity resolution:** `CE_AGE_KEY` env var > `~/.config/composable.env/identity` > `~/.ssh/id_ed25519` > `~/.ssh/id_rsa`

**CI/CD:** Set `CE_AGE_KEY` as a secret in your CI environment.

### PM2 execution — ce start

> Requires: [PM2](https://pm2.io/) installed globally (`npm install -g pm2`)

`ce start` launches all services with `dev` fields as PM2 processes:

```json
{
  "name": "api",
  "location": "apps/api",
  "vars": { ... },
  "dev": {
    "command": "pnpm dev",
    "label": "API Server"
  }
}
```

```bash
ce start                # default profile, opens PM2 monit TUI
ce start production     # named profile
ce start --dry-run      # generate config without launching
```

Once running, use standard PM2 commands: `pm2 status`, `pm2 logs`, `pm2 monit`, `pm2 restart api`.

---

## Programmatic API

```typescript
import { EnvironmentBuilder } from 'composable.env';

const builder = new EnvironmentBuilder(
  process.cwd(),   // configDir
  '.env',          // outputPath
  'production'     // envName
);

const result = await builder.buildFromProfile('production');
if (!result.success) {
  console.error(result.errors);
}
```

---

## Migration from v0.5.x

```bash
ce migrate --dry-run   # preview changes
ce migrate             # apply migration
```

Converts legacy `NAMESPACE` / `required`/`optional`/`secret` format to the current `vars` format. Legacy contracts continue to work without migration.

---

## Directory structure

```
your-project/
  ce.json                     # Project config
  env/
    components/               # Reusable variable definitions (auto-discovered)
      database.env
      redis.env
    profiles/                 # Environment definitions
      local.json
      production.json
    contracts/                # Per-service variable requirements
      api.contract.json
      worker.contract.json
      platform-base.vars.json # Shared var set
    execution/                # PM2 configs (auto-generated, gitignored)
    .env.secrets.shared       # Team secrets (distribute, don't commit)
    .env.secrets.local        # Personal secrets (gitignored)
    .env.local                # Personal overrides (gitignored)
    .recipients               # Vault recipient keys (committed)
  docker-compose.yml          # Generated by ce build (gitignored)
  docker-compose.persistent.yml  # Persistent services (gitignored)
```

---

## License

MIT
