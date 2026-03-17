---
description: Work with composable.env — build, debug, scaffold, and manage environment configuration
---

You are helping a user work with **composable.env** (`ce`), a tool that builds `.env` files for every service from reusable components, profiles, and contracts.

## Architecture

- **ce.json** — Optional root config. Sets `envDir` (default `"env"`) and `defaultProfile` (default `"default"`). Scaffolded by `ce init`.
- **Components** (`env/components/*.env`) — INI files with `[default]`, `[production]`, etc. sections. Auto-discovered from filesystem. This is where non-secret, shared values live — they get versioned in git.
- **Profiles** (`env/profiles/*.json`) — Optional section overrides per environment. Support `"extends"` inheritance.
- **Contracts** (`env/contracts/*.contract.json`) — Declare what variables a service needs via `vars` field with `${component.KEY}` references.

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
| `ce init` | Scaffold env/ directory and ce.json |
| `ce build [profile]` | Build .env files for all contracts |
| `ce start [profile]` | Build + launch PM2 dev environment |
| `ce list` | Show components, profiles, contracts |
| `ce run [profile] -- <cmd>` | Build then run a command |
| `ce vault init` | Initialize age-encrypted vault |
| `ce vault set KEY=VALUE` | Encrypt a secret |
| `ce vault get KEY` | Decrypt a secret |
| `ce migrate` | Convert legacy format to vars format |
| `ce add-skill` | Install Claude Code skill |
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
    "JWT_SECRET": "${secrets.JWT_SECRET}",
    "LOG_LEVEL": "${LOG_LEVEL}"
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
- Right side = `${component.KEY}` reference resolved from the pool
- `${secrets.KEY}` pulls from the secrets layer
- Bare `${KEY}` resolves from shared/local values
- `defaults` provides fallbacks for unresolvable vars
- `dev` defines how `ce start` runs this service via PM2
- `onlyProfiles` — optional array of ce profile names. If set, the contract is only included when building one of those profiles. Useful for dev-only services (log aggregators, debug tools) that shouldn't exist in production builds

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
    "JWT_SECRET": "${secrets.JWT_SECRET}"
  },
  "dev": { "command": "pnpm dev" }
}
```

Multiple contracts targeting the same service are **additive** — both `config` (arrays concatenated, objects merged) and `vars` (merged) accumulate. A contract can have `location`, `target`, or both:
- `location` only → writes `.env.{profile}` (local dev)
- `target` only → writes into docker-compose.yml (Docker only)
- Both → writes to both (local dev + Docker from the same contract)

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

## Anti-patterns to watch for

1. **Never assemble URLs in contracts** — composite values like `DATABASE_URL` belong in the component. Contracts should reference `${database.URL}`, not `${database.PROTOCOL}://${database.USER}@${database.HOST}:${database.PORT}/${database.NAME}`. If 5 contracts all build the same URL inline, that's 5 places to update when the format changes.
2. **Never hardcode values in contracts** — every value should be a `${component.KEY}` or `${secrets.KEY}` reference. Use `defaults` only for truly static fallback values like `LOG_LEVEL=info`. A URL like `http://localhost:3665` should be `${game-server.URL}` so it varies by profile.
3. **Don't duplicate expressions across contracts** — if multiple contracts need the same assembled value, put it in a component and reference it. One source of truth, many consumers.
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
