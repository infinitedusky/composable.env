---
title: "ce.json Root Configuration File"
date: 2026-03-15
status: completed
---

# ce.json Root Configuration File

## Goal

Add a `ce.json` root config file that lets projects customize the env directory path and default profile, loaded automatically by all CLI commands and the builder API.

## Scope

### In Scope
- `ce.json` schema definition with Zod validation
- Config loading function used by all CLI commands
- Thread `envDir` through builder, contracts, execution, and vault
- Thread `defaultProfile` through all profile resolution paths
- `ce init` scaffolds `ce.json`
- Documentation and skill updates

### Out of Scope
- Additional config fields beyond `envDir` and `defaultProfile` (future work)
- Migration tooling for existing projects (it's additive, no migration needed)

## Checklist

### Phase 1: Config schema and loader
- [x] Add `CeConfig` interface and `CeConfigSchema` Zod schema to `src/types.ts`
- [x] Create `src/config.ts` with `loadConfig(projectRoot: string): CeConfig` — reads `ce.json`, validates, returns defaults for missing fields
- [x] Export `loadConfig` and `CeConfig` from `src/index.ts`

### Phase 2: Thread envDir through core classes
- [x] Update `EnvironmentBuilder` constructor to accept `envDir` (default `'env'`), replace all `path.join(this.configDir, 'env', ...)` with `path.join(this.configDir, envDir, ...)`
- [x] Update `ContractManager` constructor to accept `envDir`, replace `path.join(configDir, 'env', 'contracts')` usage
- [x] Update `ExecutionManager` constructor to accept `envDir`, replace `path.join(configDir, 'env', 'execution')` usage
- [x] Update `Vault` constructor to accept `envDir`, replace `path.join(configDir, 'env', ...)` paths

### Phase 3: Thread defaultProfile through CLI
- [x] Update `cli/commands/build.ts` — load config, use `config.defaultProfile` as fallback instead of hardcoded `'default'`
- [x] Update `cli/commands/run.ts` — load config, use `config.defaultProfile` as fallback
- [x] Update `cli/commands/start.ts` — load config, use `config.defaultProfile` as fallback
- [x] Update `cli/commands/script.ts` — load config, save scripts to ce.json, pass `envDir` to builder/contracts
- [x] Update `cli/commands/list.ts` — load config, pass `envDir` to builder
- [x] Update `cli/commands/migrate.ts` — load config, pass `envDir`
- [x] Update `cli/commands/init.ts` — scaffold `ce.json` with defaults, `--env-dir` option, pass `envDir`
- [x] Update `cli/commands/uninstall.ts` — load config, use `envDir` for cleanup paths
- [x] Update `cli/commands/vault.ts` — load config, pass `envDir` to Vault

### Phase 4: Documentation and skill
- [x] Update README.md — add ce.json section, update directory structure, update profile resolution
- [x] Update AGENTS.md — add ce.json to code structure and key patterns
- [x] Update `skills/SKILL.md` — add ce.json guidance, anti-pattern warnings, ce.json docs

### Verification
- [x] `npm run build` — clean compile
- [x] `ce build` with no `ce.json` works identically to before (backwards compat)
- [x] `ce start --dry-run` works with defaults
- [ ] `ce build` with `ce.json` `defaultProfile: "local"` uses local profile
- [ ] `ce build` with `ce.json` `envDir: "config/env"` reads from custom path
- [ ] `--profile` flag still overrides `ce.json` `defaultProfile`
- [ ] `CE_PROFILE` env var still overrides `ce.json` `defaultProfile`
- [ ] Invalid `ce.json` (bad JSON, wrong types) produces clear error

## Files Affected

| File | Change |
|------|--------|
| `src/types.ts` | Add `CeConfigSchema` and `CeConfig` type |
| `src/config.ts` | New — `loadConfig()` function |
| `src/index.ts` | Export `loadConfig` and `CeConfig` |
| `src/builder.ts` | Accept `envDir` param, replace hardcoded `'env'` paths |
| `src/contracts.ts` | Accept `envDir` param, replace hardcoded `'env'` path |
| `src/execution/index.ts` | Accept `envDir` param |
| `src/vault.ts` | Accept `envDir` param |
| `cli/commands/build.ts` | Load config, use `defaultProfile` and `envDir` |
| `cli/commands/run.ts` | Load config, use `defaultProfile` and `envDir` |
| `cli/commands/start.ts` | Load config, use `defaultProfile` and `envDir` |
| `cli/commands/init.ts` | Scaffold `ce.json`, use `envDir` |
| `cli/commands/list.ts` | Load config, pass `envDir` |
| `cli/commands/script.ts` | Load config, pass `envDir` |
| `cli/commands/migrate.ts` | Load config, pass `envDir` |
| `cli/commands/uninstall.ts` | Load config, use `envDir` for cleanup |
| `cli/commands/vault.ts` | Load config, pass `envDir` |
| `README.md` | Add ce.json section |
| `AGENTS.md` | Add ce.json to structure docs |
| `skills/SKILL.md` | Add ce.json guidance |

## Dependencies

- None — this is additive, fully backwards compatible

## Notes

- The `envDir` field is relative to the project root (where `ce.json` lives). Absolute paths should be rejected.
- `ce.json` is loaded once per command invocation. No caching needed since CLI commands are short-lived.
- The config object should be passed explicitly (not as a global) to keep the code testable.
- Profile resolution priority: `--profile` flag > `CE_PROFILE` env var > `ce.json defaultProfile` > `"default"`
