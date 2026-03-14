# composable.env

> Build `.env` files for every service from reusable **components**, **profiles**, and **contracts**.

Like CSS for environment variables. Define once, compose everywhere, validate against contracts. Encrypt secrets inline — no external service needed.

```
npm install composable.env
```

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
  - [Components](#components)
  - [Secrets](#secrets)
  - [Profiles](#profiles)
  - [Contracts](#contracts)
  - [Shared & local values](#shared--local-values)
- [Vault — encrypted secrets](#vault--encrypted-secrets)
- [CLI reference](#cli-reference)
- [Monorepo / Turborepo setup](#monorepo--turborepo-setup)
- [Programmatic API](#programmatic-api)
- [Directory structure](#directory-structure)
- [How it works](#how-it-works)
- [Migration from v0.5.x](#migration-from-v05x)

---

## Install

```bash
# Global (recommended for standalone use)
npm install -g composable.env

# Local dev dependency (recommended for monorepos)
npm install -D composable.env
```

Requires Node.js 18+. The CLI command is `ce` (alias: `cenv`).

### Vault (optional)

If you want to encrypt secrets in `.env.secrets.shared`, install the vault dependencies:

```bash
npm install age-encryption sops-age @noble/curves @scure/base
```

The vault is completely optional — composable.env works fully without it. See [Vault — encrypted secrets](#vault--encrypted-secrets) for details.

---

## Quick start

### 1. Scaffold the project

```bash
ce init --examples
```

This creates the `env/` directory structure with example components, profiles, contracts, and secrets.

### 2. See what was created

```
env/
  components/
    database.env          # Database variables by environment (auto-discovered)
    redis.env             # Redis variables by environment (auto-discovered)
  profiles/
    production.json       # Production overrides (optional)
    staging.json          # Staging — extends production (optional)
  contracts/
    api.contract.json     # What the API service needs
  .env.secrets.shared     # Team secrets — encrypted via vault (committed)
  .env.secrets.local      # Personal secret overrides (gitignored)
  .env.local              # Personal non-secret overrides (gitignored)
```

### 3. Build environment files

```bash
# Build for local development (default profile)
ce build

# Build for production
ce build --profile production

# Build for staging
ce build --profile staging
```

Each contract generates a `.env.{profile}` file at the service's `location`:

```
apps/api/.env.production
apps/web/.env.production
apps/worker/.env.production
```

### 4. Run a command with the environment loaded

```bash
ce run -- npm start

# With a specific profile
ce run --profile staging -- npm start

# Profile as trailing arg (auto-detected)
ce run -- npm start production
```

If the `.env.*` file doesn't exist yet, `ce run` auto-builds it.

---

## Core concepts

### Components

INI files with named sections. Each section maps to a profile name. Secrets are referenced with `${secrets.KEY}`.

```ini
; env/components/database.env

[default]
HOST=localhost
PORT=5432
NAME=myapp_dev
USER=${secrets.DB_USER}
PASSWORD=${secrets.DB_PASSWORD}
URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@localhost:5432/myapp_dev

[production]
HOST=${secrets.DB_HOST}
NAME=myapp
URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp

[staging]
HOST=${secrets.DB_HOST}
NAME=myapp_staging
URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp_staging
```

- `[default]` section is required — provides local development values
- `${secrets.KEY}` resolves from the secrets layer (`.env.secrets.shared` + `.env.secrets.local`)
- Sections layer on top of `[default]`: production gets `[default]` + `[production]`
- Components can reference each other in contracts via `${component.KEY}`

### Secrets

Secrets are managed in two files:

| File | Purpose | Committed? |
|------|---------|-----------|
| `env/.env.secrets.shared` | Team secrets — encrypted via vault | Yes |
| `env/.env.secrets.local` | Personal secret overrides | Never (gitignored) |

```bash
# env/.env.secrets.shared — committed, values encrypted via vault
DB_USER=CENV_ENC[...]
DB_PASSWORD=CENV_ENC[...]
DB_HOST=CENV_ENC[...]

# env/.env.secrets.local — gitignored, plaintext for local dev
DB_USER=postgres
DB_PASSWORD=postgres
DB_HOST=localhost
```

Components reference secrets with `${secrets.KEY}`. The secrets layer is resolved first, before component values.

### Profiles

Optional JSON files that override which INI sections to use per component. All component files in `env/components/` are auto-discovered — no need to list them.

Without any profile file, `ce build` loads every component's `[default]` section. A named profile layers `[default]` + `[profileName]` sections automatically.

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

Staging inherits everything from production but overrides database to use the `[staging]` section.

Profiles can extend other profiles via `"extends"`. The `components` object maps component names to section names (or arrays of section names) when you need to override the default layering.

### Contracts

JSON files that declare what variables a service needs. Contracts use `vars` to map component values to app variable names using `${component.KEY}` references.

```json
// env/contracts/api.contract.json
{
  "name": "api",
  "location": "apps/api",
  "vars": {
    "DATABASE_URL": "${database.URL}",
    "REDIS_URL": "${redis.URL}",
    "JWT_SECRET": "${auth.JWT_SECRET}",
    "LOG_LEVEL": "${LOG_LEVEL}",
    "CORS_ORIGIN": "${CORS_ORIGIN}"
  },
  "defaults": {
    "LOG_LEVEL": "info",
    "CORS_ORIGIN": "http://localhost:3000"
  },
  "dev": {
    "command": "pnpm dev",
    "label": "API Server"
  }
}
```

| Field | Purpose |
|-------|---------|
| `name` | Service identifier |
| `location` | Where to write the `.env.{profile}` file |
| `vars` | Maps app variable names to component references |
| `defaults` | Fallback values when a reference resolves to nothing |
| `dev` | Process configuration for `ce start` (PM2 dev environment) |

The left side is the **app variable name** (what the service sees). The right side is a `${component.KEY}` reference that resolves from the component pool. Bare `${KEY}` references resolve from the flat pool (shared values, local overrides).

Contracts also support TypeScript (`.contract.ts`) when a transpiler like `tsx` or `jiti` is available.

> **Legacy format**: Contracts with `required`/`optional`/`secret` fields are still supported. See [Migration from v0.5.x](#migration-from-v05x).

### Shared & local values

| File | Purpose | Committed? |
|------|---------|-----------|
| `env/.env.shared` | Team-wide non-secret values | Yes |
| `env/.env.local` | Personal overrides | Never (gitignored) |

`.env.local` always takes precedence over `.env.shared`. Both are applied after components.

```bash
# env/.env.shared — committed, shared across the team
API_URL=http://localhost:4000
APP_NAME=MyApp

# env/.env.local — gitignored, personal overrides
LOG_LEVEL=debug
```

---

## Vault — encrypted secrets

> **Optional feature.** Requires additional dependencies:
> ```bash
> npm install age-encryption sops-age @noble/curves @scure/base
> ```

The vault encrypts secret values directly in `.env.secrets.shared` so the file can be committed safely. Keys stay plaintext, values get encrypted inline. No external service needed.

Encryption uses [age](https://age-encryption.org/) — a modern, audited encryption tool. Team access is managed via public keys, and your existing SSH key works automatically.

### Set up the vault

```bash
# With CODEOWNERS protection (recommended)
ce vault init --github your-username

# Without CODEOWNERS
ce vault init
```

This creates `env/.recipients` and adds your public key. If you have `~/.ssh/id_ed25519`, it's used automatically. Otherwise, a new age keypair is generated at `~/.config/composable.env/identity`.

The `--github` flag also creates `.github/CODEOWNERS` to protect `env/.recipients` — preventing unauthorized changes to the recipient list via GitHub branch protection. If omitted, the GitHub CLI (`gh`) is checked for your username automatically.

### Store a secret

```bash
ce vault set DB_PASSWORD "s3cret-p@ssw0rd"
```

The value is encrypted and written to `.env.secrets.shared`:

```
DB_PASSWORD=CENV_ENC[LS0tLS1CRUdJTi...]
```

Now you can safely commit `.env.secrets.shared`.

### Read a secret

```bash
ce vault get DB_PASSWORD
# → s3cret-p@ssw0rd
```

### List encrypted keys

```bash
ce vault ls
```

### Add a team member

```bash
# From GitHub (fetches their SSH public keys)
ce vault add --github alice

# From a raw age public key
ce vault add --key "age1abc123..." --comment "Bob"
```

Adding a recipient automatically re-encrypts all existing secrets so the new team member can decrypt them.

### Remove a team member

```bash
ce vault remove alice
```

Removes the recipient and re-encrypts all secrets without their key.

### List recipients

```bash
ce vault recipients
```

### How it works during build

When `ce build` encounters `CENV_ENC[...]` values in `.env.secrets.shared`, it decrypts them transparently before building. No extra flags needed — if you can decrypt (you have a matching key), it just works.

### Identity resolution order

1. `CE_AGE_KEY` environment variable (raw age secret key — for CI)
2. `~/.config/composable.env/identity` (age identity file)
3. `~/.ssh/id_ed25519` (auto-converted to age format)
4. `~/.ssh/id_rsa` (auto-converted to age format)

> Legacy: `CENV_AGE_KEY` is also accepted as a fallback.

### CI / deployment

Set `CE_AGE_KEY` as a secret in your CI environment:

```yaml
# GitHub Actions example
env:
  CE_AGE_KEY: ${{ secrets.CE_AGE_KEY }}
```

To get the age secret key for CI, generate a dedicated key:

```bash
npx age-encryption -g  # prints identity + recipient
# Add the recipient: ce vault add --key "age1..."
# Set AGE-SECRET-KEY-1... as CE_AGE_KEY in CI
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `ce init [--examples]` | Scaffold the `env/` directory structure |
| `ce build [--profile name]` | Build `.env` files from a profile |
| `ce list` | List available profiles |
| `ce run [--profile name] -- <cmd>` | Load env and run a command (auto-builds) |
| `ce script <name> -c <cmd>` | Inject a single profile-aware script |
| `ce scripts -c <cmd> [--actions dev,build,start]` | Generate per-app scripts from contracts |
| `ce scripts:sync` | Regenerate scripts from `ce.json` |
| `ce scripts:register <name...>` | Register existing package.json scripts for uninstall cleanup |
| `ce vault init [--github <user>]` | Initialize the vault (optionally set up CODEOWNERS) |
| `ce vault set <KEY> <VALUE>` | Encrypt and store a secret |
| `ce vault get <KEY>` | Decrypt and print a secret |
| `ce vault ls` | List encrypted keys |
| `ce vault add --github <user>` | Add recipient from GitHub SSH keys |
| `ce vault add --key <key>` | Add recipient from raw public key |
| `ce vault remove <identifier>` | Remove a recipient |
| `ce vault recipients` | List all recipients |
| `ce start [profile]` | Build env + launch PM2 dev environment |
| `ce start --dry-run` | Generate ecosystem config without launching |
| `ce migrate [--dry-run]` | Migrate from legacy NAMESPACE format to new format |
| `ce uninstall [--all] [--dry-run]` | Remove all composable.env artifacts |

### Profile resolution

The `--profile` flag accepts a profile name. You can also:

- Pass the profile as the last positional argument: `ce run -- npm start production`
- Set the `CE_PROFILE` environment variable (legacy: `CENV_PROFILE`)
- Default is `"default"` if nothing is specified

---

## Execution — PM2 dev environment

> **Optional feature.** Requires [PM2](https://pm2.io/) installed globally: `npm install -g pm2`

`ce start` launches all your services as PM2 processes — one command to get a full dev environment running with log aggregation, process monitoring, and automatic restarts.

### Add dev commands to contracts

```json
// env/contracts/api.contract.json
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

| Field | Purpose |
|-------|---------|
| `command` | Shell command to run as a PM2 process |
| `cwd` | Working directory (defaults to `location`) |
| `label` | Display name (defaults to `name`) |

Contracts without a `dev` field are skipped — they get env files but no process.

### Launch

```bash
ce start                    # default profile
ce start production         # named profile
ce start --dry-run          # generate ecosystem config, don't launch
```

This builds the env files, generates a PM2 `ecosystem.config.cjs` from your contracts, starts all processes, and tails the aggregated logs.

### Managing processes

Once running, use standard PM2 commands:

```bash
pm2 status                  # see all processes
pm2 logs                    # tail all logs
pm2 logs api                # tail a specific service
pm2 restart api             # restart a service
pm2 stop all                # stop everything
pm2 delete all              # remove all processes
pm2 monit                   # interactive dashboard (TUI)
```

The generated `ecosystem.config.cjs` is gitignored.

---

## Monorepo / Turborepo setup

### Install

```bash
# At the monorepo root
npm install -D composable.env
```

### Initialize

```bash
ce init
```

This auto-detects `turbo.json` and adds `env/**` to `globalDependencies`.

### Generate per-app scripts

```bash
ce scripts -c turbo --actions dev,build,start
```

This reads your contracts and generates scripts in `package.json`:

```json
{
  "scripts": {
    "env:build:api": "ce build --profile",
    "dev:api": "ce run --profile -- turbo dev --filter=api",
    "build:api": "ce run --profile -- turbo build --filter=api",
    "start:api": "ce run --profile -- turbo start --filter=api",
    "dev:all": "ce run --profile -- turbo dev",
    "build:all": "ce run --profile -- turbo build",
    "start:all": "ce run --profile -- turbo start",
    "dev": "ce run --profile default -- turbo dev",
    "build": "ce run --profile default -- turbo build",
    "start": "ce run --profile default -- turbo start"
  }
}
```

Usage:

```bash
# Build env for production, then start the api
pnpm env:build:api production
pnpm start:api production

# Build all contract-mapped services for production
pnpm build:all production

# Or just dev everything locally
pnpm dev
```

The script config is saved to `ce.json`. Regenerate anytime with `ce scripts:sync`.

If you hand-write scripts in `package.json` and want `ce uninstall` to remove them later, register them:

```bash
ce scripts:register build:all build:docs build:sim
```

### Service .env loading

Each app reads its `.env.{profile}` file. In Next.js:

```js
// next.config.js
const { config } = require('dotenv');
config({ path: `.env.${process.env.CURRENT_ENV || 'default'}` });
```

In Express / Node:

```js
require('dotenv').config({
  path: `.env.${process.env.CURRENT_ENV || 'default'}`
});
```

---

## Programmatic API

```typescript
import { EnvironmentBuilder } from 'composable.env';

// Build from a profile
const builder = new EnvironmentBuilder(
  process.cwd(),   // configDir (where env/ lives)
  '.env',          // outputPath
  'production'     // envName (for .env.{profile} files)
);

const result = await builder.buildFromProfile('production');
if (!result.success) {
  console.error(result.errors);
  process.exit(1);
}

// Vault API (requires vault dependencies installed)
const { Vault } = await import('composable.env/vault');
const vault = new Vault(process.cwd());
await vault.init();
await vault.setSecret('API_KEY', 'sk-123');
const value = await vault.getSecret('API_KEY');
await vault.addGitHubRecipient('alice');
```

---

## Directory structure

```
your-project/
  env/
    components/           # Reusable variable definitions — auto-discovered
      database.env
      redis.env
      auth.env
    profiles/             # Optional section overrides per environment
      production.json
      staging.json
    contracts/            # Per-service variable requirements (JSON or TS)
      api.contract.json
      web.contract.json
      worker.contract.json
    execution/            # PM2 ecosystem configs (auto-generated, gitignored)
    .env.secrets.shared   # Team secrets — encrypted via vault (committed)
    .env.secrets.local    # Personal secret overrides (gitignored)
    .env.shared           # Team non-secret values (committed)
    .env.local            # Personal overrides (gitignored)
    .recipients           # Vault recipient public keys (committed)
  ce.json                 # Script config (if using ce scripts)
  .ce-managed.json        # Tracks what ce manages in package.json
```

---

## How it works

1. **Discover** all component files in `env/components/`
2. **Resolve** profile inheritance chain (e.g., `staging` extends `production`)
3. **Load secrets** from `.env.secrets.shared` (decrypt `CENV_ENC[...]` values) + `.env.secrets.local`
4. **Compose** each component's sections: `[default]` + `[production]` + `[staging]`
5. **Resolve** `${secrets.KEY}` references in components from the secrets pool
6. **Resolve** cross-component `${component.KEY}` references (multi-pass)
7. **Layer** `.env.shared` (team values) then `.env.local` (personal overrides)
8. **Map** contract `vars` — resolve `${component.KEY}` from the component pool
9. **Apply** defaults for any unresolved vars
10. **Write** one `.env.{profile}` file per contract at the service's `location`

---

## Migration from v0.5.x

If you have an existing composable.env setup using the legacy `NAMESPACE` / `required`/`optional`/`secret` format, run:

```bash
# See what would change
ce migrate --dry-run

# Apply the migration
ce migrate
```

This will:
- Remove `NAMESPACE=` directives from component files
- Add `${secrets.KEY}` references where components referenced shared values
- Convert contracts from `required`/`optional`/`secret` to `vars` with `${component.KEY}` syntax
- Split encrypted secrets from `.env.shared` into `.env.secrets.shared`
- Create `.env.secrets.local` for personal secret overrides

Legacy-format contracts (`required`/`optional`/`secret`) continue to work without migration — the new format is opt-in per contract.

---

## Uninstall

```bash
# See what would be removed
ce uninstall --dry-run

# Remove all generated files and managed keys
ce uninstall

# Also remove the env/ directory
ce uninstall --all
```

---

## License

MIT
