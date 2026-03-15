---
description: Work with composable.env — build, debug, scaffold, and manage environment configuration
---

You are helping a user work with **composable.env** (`ce`), a tool that builds `.env` files for every service from reusable components, profiles, and contracts.

## Architecture

- **ce.json** — Optional root config. Sets `envDir` (default `"env"`) and `defaultProfile` (default `"default"`). Scaffolded by `ce init`.
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
4. **Don't put secrets directly in components** — secrets go in `.env.secrets.shared` (encrypted) or `.env.secrets.local` (gitignored). Components reference them with `${secrets.KEY}`.
5. **Don't leave profiles underspecified** — every profile that gets built should produce a complete, working env. If `production.json` only overrides `database` but the app also needs production `blockchain` and `game-server` values, the build will silently use `[default]` values for those. Audit profiles to ensure all components have appropriate section overrides.
6. **Don't keep vestigial components** — if two components define the same service's config (e.g., `partykit.env` and `game-server.env` both defining HOST for the same server), merge them. One component per logical service.
7. **Document all secrets for onboarding** — if a secret exists only in `.env.secrets.local` with no encrypted counterpart in `.env.secrets.shared`, new developers can't build without manual setup. Every team secret should be in the vault (`ce vault set`), with `.env.secrets.local` only for personal overrides.
8. **Don't leave deploy-time values blank** — if a component has keys like `DIAMOND_ADDRESS=` that must be populated after a deploy, document this in the component file with a comment and consider a post-deploy script that writes to the component or vault.
9. **Don't manually source env in Docker** — `ce start` generates a PM2 ecosystem config that reads `.env.{profile}` automatically. If your Docker entrypoint manually sources env files, replace that with `ce build && ce start` in the container.

## When helping the user

1. **Scaffolding**: Use `ce init` for new projects. It creates `ce.json` and the directory structure.
2. **Debugging builds**: Run `ce build` and read error output. Missing vars usually mean a component is missing a key or a contract reference is wrong.
3. **Adding a service**: Create a `.contract.json` with `vars` mapping what the service needs to component keys.
4. **Adding a component**: Create a `.env` file in `env/components/` with `[default]` section. It's auto-discovered.
5. **Secrets**: Use `ce vault set KEY=VALUE` to encrypt. Reference with `${secrets.KEY}` in components.
6. **Cross-component refs**: Components can reference each other: `${database.HOST}` in a component resolves from the database component.
7. **Custom env dir**: Set `envDir` in `ce.json` if the project doesn't use the default `env/` path.
8. **Default profile**: Set `defaultProfile` in `ce.json` so the team doesn't need `--profile` on every command.
