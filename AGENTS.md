# AGENTS.md

## Overview

composable.env builds `.env` files and `docker-compose.yml` for every service from reusable **components**, **profiles**, and **contracts**. Define once, compose everywhere. Version the source of truth, gitignore the outputs.

## Setup

```bash
npm install
npm run build        # tsc
npm test             # vitest
```

## Architecture

### Core building blocks

1. **Components** (`env/components/*.env`) — INI files with named sections (`[default]`, `[production]`, etc.). One file per logical service. Reference secrets with `${secrets.KEY}`, other components with `${component.KEY}`.
2. **Profiles** (`env/profiles/*.json`) — Define environments. Only JSON files create profiles — component sections alone don't. Support inheritance via `"extends"`.
3. **Contracts** (`env/contracts/*.contract.json`) — Declare what variables a service needs via `vars` with `${component.KEY}` references. Can output to `.env` files (`location`) and/or Docker Compose (`target`).
4. **Var sets** (`env/contracts/*.vars.json`) — Reusable variable bundles. Contracts inherit via `includeVars`. Support chaining with cycle detection.

### Secrets layer

| File | Purpose | In git? |
|------|---------|---------|
| `env/.env.secrets.shared` | Team secrets (optionally encrypted via vault) | Distribute, don't commit |
| `env/.env.secrets.local` | Personal secret overrides | Never |

Secrets flow: `secrets → components → contracts → output`. Contracts never reference secrets directly.

### Resolution chain

```
secrets pool: .env.secrets.shared + .env.secrets.local
  → generate ${service.*} vars from ce.json profiles config
  → components[default] + components[profile sections]
    → Pass 1: resolve ${secrets.KEY}
    → Pass 2: resolve ${component.KEY} cross-refs (multi-pass)
    → Pass 3: resolve ${service.*} networking refs
    → .env.local overrides
      → contract vars mapping
        → includeVars merge
        → defaults for unresolved vars
          → write .env.{profile} per location
          → write docker-compose.yml per target
```

### Docker Compose targets

Contracts with `target` fields generate a complete `docker-compose.yml`:

- `target.config` — full Docker service definition (image, ports, volumes, healthchecks)
- `target.profileOverrides` — per-profile config overrides (different Dockerfile, remove volumes)
- Multi-profile output with YAML anchors (`x-` blocks + `<<: *anchor` merge)
- Every service is always profiled (`{name}{suffix}`)
- `depends_on` rewritten to profiled names automatically
- Multiple contracts targeting the same service merge additively
- `persistent: true` routes to `docker-compose.persistent.yml`

### Service networking

`ce.json` `profiles` config provides `suffix`, `domain`, and per-service `override`. Auto-generates `${service.<name>.host}`, `.address`, `.suffix`, `.domain` vars. Also generates `${service.default.suffix}` and `${service.default.domain}`.

### ce.json — project config

| Field | Default | Purpose |
|-------|---------|---------|
| `envDir` | `"env"` | Path to env directory |
| `defaultProfile` | `"default"` | Default profile |
| `profiles` | — | Per-profile suffix, domain, and per-service overrides |
| `scripts` | — | Script generation config (managed by `ce scripts`) |

### Legacy format

Contracts with `required`/`optional`/`secret` (v0.5.x) still work. `isNewFormatContract()` routes resolution.

## Code structure

```
src/
  index.ts          # Public API exports
  config.ts         # loadConfig/saveConfig — ce.json loader
  builder.ts        # EnvironmentBuilder — core build logic
  contracts.ts      # ContractManager — validation, var mapping, includeVars resolution
  types.ts          # Zod schemas + TypeScript types
  markers.ts        # Marker blocks for managed file sections
  vault.ts          # Vault — age encryption, recipient management
  targets/
    docker-compose.ts # Docker Compose file generation (multi-profile, anchors, persistent)
  execution/
    index.ts        # ExecutionManager — PM2 ecosystem generation
    ecosystem.ts    # PM2 ecosystem config from contracts

cli/
  index.ts          # Commander program, registers all commands
  commands/
    build.ts        # ce build [--profile]
    init.ts         # ce init [--scaffold docker]
    list.ts         # ce list
    migrate.ts      # ce migrate [--dry-run]
    run.ts          # ce run [--profile] -- <cmd>
    script.ts       # ce script/scripts/scripts:sync/scripts:register
    start.ts        # ce start [profile] — PM2 dev environment
    persistent.ts   # ce persistent up/down/destroy/status
    add-skill.ts    # ce add-skill — install Claude Code skill
    uninstall.ts    # ce uninstall [--all]
    vault.ts        # ce vault init/set/get/ls/add/remove/recipients

examples/
  fullstack/        # Multi-service .env example
  docker-compose/   # Docker Compose target example
```

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- `.js` extensions in imports (TS compiles to JS)
- Commander for CLI, chalk for terminal output, zod for schemas
- `yaml` package for YAML generation (Document API for anchors/aliases)
- `ini` package for component parsing
- CLI pattern: `cli/commands/<name>.ts` exports `registerXCommand(program)`, registered in `cli/index.ts`

## Testing

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

## Key patterns

- **Marker blocks**: `# ce:start` / `# ce:end` for managed sections in .gitignore etc.
- **ManagedJsonRegistry**: Tracks injected JSON keys for clean `ce uninstall`.
- **Auto-discovery**: All `*.env` files in `env/components/` auto-discovered.
- **Profile inheritance**: Child profiles merge parent overrides. Circular inheritance detected.
- **Always profiled**: Docker services always get `{name}{suffix}`. No bare `docker compose up`.
- **Contagious profiling**: `depends_on` references to profiled services cause the depending service to also be profiled.
- **Atomic validation**: All contracts validated before any files written.
- **Component-scoped pool**: `Map<string, Record<string, string>>` keyed by component name. `secrets` and `service` are reserved namespaces.
