---
description: Work with composable.env — build, debug, scaffold, and manage environment configuration
---

You are helping a user work with **composable.env** (`ce`), a tool that builds `.env` files for every service from reusable components, profiles, and contracts.

## Architecture

- **Components** (`env/components/*.env`) — INI files with `[default]`, `[production]`, etc. sections. Auto-discovered from filesystem.
- **Profiles** (`env/profiles/*.json`) — Optional section overrides per environment. Support `"extends"` inheritance.
- **Contracts** (`env/contracts/*.contract.json`) — Declare what variables a service needs via `vars` field with `${component.KEY}` references.
- **Secrets** — `env/.env.secrets.shared` (encrypted, committed) + `env/.env.secrets.local` (plaintext, gitignored). Referenced via `${secrets.KEY}`.
- **Shared/Local** — `env/.env.shared` (team values) + `env/.env.local` (personal overrides).

## Resolution chain

```
secrets → components[default] + components[profile] → resolve ${secrets.KEY} → resolve ${component.KEY} → .env.shared + .env.local → contract mapping → defaults → write .env.{profile}
```

## CLI commands

| Command | Purpose |
|---------|---------|
| `ce init` | Scaffold env/ directory structure |
| `ce build [profile]` | Build .env files for all contracts |
| `ce start [profile]` | Build + launch PM2 dev environment |
| `ce list` | Show components, profiles, contracts |
| `ce run [profile] -- <cmd>` | Build then run a command |
| `ce vault init` | Initialize age-encrypted vault |
| `ce vault set KEY=VALUE` | Encrypt a secret |
| `ce vault get KEY` | Decrypt a secret |
| `ce migrate` | Convert legacy format to vars format |
| `ce uninstall` | Remove all ce artifacts |

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

## When helping the user

1. **Scaffolding**: Use `ce init` for new projects. Components go in `env/components/`, contracts in `env/contracts/`.
2. **Debugging builds**: Run `ce build` and read error output. Missing vars usually mean a component is missing a key or a contract reference is wrong.
3. **Adding a service**: Create a `.contract.json` with `vars` mapping what the service needs to component keys.
4. **Adding a component**: Create a `.env` file in `env/components/` with `[default]` section. It's auto-discovered.
5. **Secrets**: Use `ce vault set KEY=VALUE` to encrypt. Reference with `${secrets.KEY}` in components.
6. **Cross-component refs**: Components can reference each other: `${database.HOST}` in a component resolves from the database component.
