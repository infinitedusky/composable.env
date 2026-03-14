# AGENTS.md

## Overview

composable.env builds `.env` files for every service from reusable **components**, **profiles**, and **contracts**. Think CSS for environment variables — define once, compose everywhere, validate against contracts.

## Setup

```bash
npm install
npm run build        # tsc
npm test             # vitest
```

## Architecture

### Three building blocks

1. **Components** (`env/components/*.env`) — INI files with named sections (`[default]`, `[production]`, etc.). Reference secrets with `${secrets.KEY}` syntax. Keys are unnamespaced — what you write is what you get.
2. **Profiles** (`env/profiles/*.json`) — Optional section overrides per environment. Support inheritance via `"extends"`. Components are auto-discovered from `env/components/` — no registry file needed.
3. **Contracts** (`env/contracts/*.contract.json` or `.contract.ts`) — Declare what variables a service needs via `vars` field with `${component.KEY}` references. Build fails atomically if any required var is unresolvable. Support `defaults` for fallback values and optional `dev` field for `ce start` pane configuration.

### Secrets layer

| File | Purpose | In git? |
|------|---------|---------|
| `env/.env.secrets.shared` | Team secrets, encrypted via vault | Yes |
| `env/.env.secrets.local` | Personal secret overrides | Never |

Components reference secrets via `${secrets.KEY}`. The secrets pool is loaded and decrypted before component resolution.

### Resolution chain

```
secrets pool: .env.secrets.shared (decrypt CENV_ENC[...]) + .env.secrets.local
  -> components[default] + components[profile sections]
    -> Pass 1: resolve ${secrets.KEY} in components
    -> Pass 2: resolve ${component.KEY} cross-references (multi-pass, max 10)
    -> .env.shared (team values) + .env.local (personal overrides)
      -> contract vars mapping: ${component.KEY} -> app variable names
        -> defaults for unresolved vars
          -> write .env.{profile} files per contract location
```

### Value layers

| File | Purpose | In git? |
|------|---------|---------|
| `env/.env.secrets.shared` | Team secrets (encrypted) | Yes |
| `env/.env.secrets.local` | Personal secret overrides | Never |
| `env/.env.shared` | Team-wide non-secret values | Yes |
| `env/.env.local` | Personal overrides | Never |

### Legacy format support

Contracts with `required`/`optional`/`secret` fields (v0.5.x format) are auto-detected and still work. The builder checks `isNewFormatContract()` (presence of `vars` field) to route to new or legacy resolution paths. Components with `NAMESPACE=` directives still produce prefixed keys in legacy mode.

## Code structure

```
src/
  index.ts          # Public API exports
  builder.ts        # EnvironmentBuilder — core build logic
  contracts.ts      # ContractManager — validation + variable mapping
  types.ts          # Zod schemas + TypeScript types
  markers.ts        # Marker blocks for managed file sections
  vault.ts          # Vault — age encryption, recipient management
  execution/
    index.ts        # ExecutionManager — PM2 ecosystem generation + process management
    ecosystem.ts    # PM2 ecosystem config generation from contracts

cli/
  index.ts          # Commander program setup, registers all commands
  commands/
    build.ts        # ce build --profile <name>
    init.ts         # ce init [--examples]
    list.ts         # ce list
    migrate.ts      # ce migrate [--dry-run] — legacy to new format
    run.ts          # ce run --profile <name> -- <command>
    script.ts       # ce script <name> -c <command>
    start.ts        # ce start [profile] — PM2 dev environment
    uninstall.ts    # ce uninstall [--all] [--dry-run]
    vault.ts        # ce vault init/set/get/ls/add/remove/recipients

examples/
  fullstack/        # Multi-service example with components, profiles, contracts
```

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- `.js` extensions in imports (TypeScript compiles to JS)
- Commander for CLI, chalk for terminal output, zod for schemas
- CLI command pattern: `cli/commands/<name>.ts` exports `registerXCommand(program: Command): void`, registered in `cli/index.ts`
- INI parsing via `ini` package, YAML via `yaml` package
- Contracts support `.contract.json` (preferred, no transpiler) and `.contract.ts`/`.contract.js` (requires tsx/jiti for TS)

### Planning docs naming

- ADR/Impl planning docs must use: `v{V}-{YYYY-MM-DD}-{N}-{kebab-title}-{adr|impl}.md`
- New planning docs must start at `v1`

## Testing

```bash
npm test             # Run vitest
npm run typecheck    # tsc --noEmit
```

## Key patterns

- **Marker blocks**: `# ce:start` / `# ce:end` for managed sections in .gitignore etc. See `src/markers.ts`.
- **ManagedJsonRegistry**: Tracks which JSON keys ce injected (e.g., package.json scripts, turbo.json deps) so `ce uninstall` can cleanly remove them.
- **Auto-discovery**: All `*.env` files in `env/components/` are auto-discovered. No component registry needed.
- **Profile inheritance**: Child profiles merge parent section overrides, can selectively override. Circular inheritance is detected.
- **Atomic validation**: All contracts validated before any files are written. One failure = zero files written.
- **Component-scoped pool**: New-format builds use `Map<string, Record<string, string>>` keyed by component name. `secrets` is a reserved namespace.
- **Format detection**: `isNewFormatContract()` checks for `vars` field to route new vs legacy resolution.
- **Execution addon**: `ce start` generates a PM2 `ecosystem.config.cjs` from contracts with `dev` fields, then launches PM2 with `pm2 start` + `pm2 logs`. Each contract with a `dev` block becomes a PM2 app. Generated `.cjs` files are gitignored.
