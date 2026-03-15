---
title: "ce.json Root Configuration File"
date: 2026-03-15
status: accepted
---

# ce.json Root Configuration File

## Y-Statement

In the context of **composable.env project configuration**,
facing **hardcoded conventions for env directory paths, default profile, and output naming that can't be overridden without CLI flags on every invocation**,
we decided for **a `ce.json` file at the project root that declares project-level settings, loaded automatically by all CLI commands and the builder API**
and against **environment variables only, package.json config field, or .rc file formats**,
to achieve **zero-flag operation for non-default project layouts and consistent configuration across CLI and programmatic usage**,
accepting **one more config file in the project root**,
because **every CLI command currently duplicates the same hardcoded defaults (`env/`, `default` profile), and projects with non-standard layouts must pass flags repeatedly or rely on undocumented env vars like `CE_PROFILE`**.

## Context

composable.env currently hardcodes several conventions:

- **Env directory**: Always `{projectRoot}/env/` — set in `EnvironmentBuilder` constructor, `ContractManager`, `ExecutionManager`, and `Vault`
- **Default profile**: `"default"` — hardcoded in `cli/commands/build.ts:15`, `run.ts:49`, `start.ts:25`, and overridable via `CE_PROFILE` env var
- **Output file naming**: `.env.{profile}` — hardcoded in builder
- **Component discovery path**: `env/components/*.env` — hardcoded in `builder.ts:308`
- **Secrets files**: `env/.env.secrets.shared` and `env/.env.secrets.local` — hardcoded in `builder.ts:447-475`

For projects that follow convention, this works. But the user feedback brief identified real gaps:
1. No way to declare "my default profile is `local`" without setting `CE_PROFILE` in every shell
2. No way to relocate the env directory (e.g., `config/env/`)
3. No project-level metadata or settings file for tooling to discover

The `ce.json` file also serves as a **sentinel** — its presence tells tools "this project uses composable.env", similar to how `tsconfig.json` signals TypeScript or `turbo.json` signals Turborepo.

## Decision

Add support for a `ce.json` file at the project root with the following schema:

```json
{
  "envDir": "env",
  "defaultProfile": "default"
}
```

### Fields

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `envDir` | `string` | `"env"` | Relative path from project root to the env configuration directory |
| `defaultProfile` | `string` | `"default"` | Profile used when no `--profile` flag or `CE_PROFILE` env var is set |

### Resolution priority (for profile)

1. Explicit `--profile` CLI flag
2. `CE_PROFILE` / `CENV_PROFILE` env var
3. `ce.json` → `defaultProfile`
4. `"default"` hardcoded fallback

### Resolution priority (for envDir)

1. `ce.json` → `envDir`
2. `"env"` hardcoded fallback

### Loading behavior

- `ce.json` is loaded once at CLI entry, before command dispatch
- The loaded config is passed to `EnvironmentBuilder`, `ContractManager`, `ExecutionManager`, and `Vault` constructors
- If `ce.json` doesn't exist, all defaults apply (fully backwards compatible)
- Invalid `ce.json` (bad JSON, unknown fields) produces a clear error and exits

## Alternatives Considered

### Environment variables only

Continue using `CE_PROFILE` and add `CE_ENV_DIR`. Rejected because env vars are invisible, per-shell, and don't serve as a project sentinel. They also can't be committed to the repo for the team.

### package.json `"ce"` field

Add config under a `"ce"` key in `package.json`. Rejected because composable.env isn't Node-specific — it manages env files for any stack. Coupling to `package.json` would be wrong for Python/Go/Rust projects.

### .cerc / .composableenvrc

A dotfile in the project root. Rejected because the project already uses JSON for profiles and contracts — consistency favors `ce.json`. Dotfiles are also less discoverable.

## Consequences

### Positive
- Projects can customize env directory and default profile without per-command flags
- `ce.json` acts as a project sentinel for tooling discovery
- Backwards compatible — absence of `ce.json` changes nothing
- Simple, small schema that can grow later if needed

### Negative
- One more file in the project root (mitigated: it's optional)
- Config loading adds a small amount of I/O to every command (mitigated: single `readFileSync` call)

### Risks
- Schema growth pressure — users may want to put everything in ce.json. Mitigation: keep the schema minimal, reject unknown fields, and prefer convention over configuration.

## References

- User improvement brief identifying #8 "No ce.json root config"
- Current hardcoded defaults in `src/builder.ts`, `cli/commands/build.ts`, `cli/commands/run.ts`, `cli/commands/start.ts`
