---
title: "Impl: Zellij Execution Folder Addon"
date: 2026-03-01
status: draft
adr: 2026-03-01-1-zellij-execution-addon-adr.md
---

# Impl: Zellij Execution Folder Addon

## Goal

Add a `ce start <profile>` command that auto-generates Zellij terminal layouts from contracts, resolves `${VAR}` placeholders using the existing variable pool, and launches a full dev environment in a single command.

## Scope

### In Scope
- Contract `dev` field extension (command, cwd, label)
- KDL layout generation from active contracts
- Template variable substitution using resolved pool
- `ce start` CLI command (build + generate + launch)
- `env/execution/` folder convention for templates and generated layouts
- Session management (named sessions, kill stale)
- `ce init` scaffolding for execution folder
- Example execution templates in `examples/fullstack/`

### Out of Scope
- tmux/screen adapters (Zellij only for v1)
- Docker Compose integration within panes (use existing `docker` profile blocks)
- Remote session support
- Layout editor / visual designer
- Log file management (services handle their own logging)

## Checklist

### Phase 1: Contract Extension

- [ ] Add optional `dev` field to `ServiceContract` interface in `src/contracts.ts`
  ```typescript
  dev?: {
    command: string;
    cwd?: string;       // defaults to location
    label?: string;     // defaults to uppercase name
  }
  ```
- [ ] Add `dev` to contract Zod schema validation (optional object)
- [ ] Update `examples/fullstack/env/contracts/api.contract.json` with example `dev` field
- [ ] Update `examples/fullstack/env/contracts/web.contract.json` with example `dev` field
- [ ] Update `examples/fullstack/env/contracts/worker.contract.json` with example `dev` field
- [ ] Verify `ce build` still works (dev field is passthrough, doesn't affect env generation)

### Phase 2: KDL Layout Generator

- [ ] Create `src/execution/` directory
- [ ] Create `src/execution/kdl.ts` — KDL layout generation module
  - `generateLayout(services: ServiceDev[], vars: Record<string, string>): string`
  - Pane-per-service layout with vertical splits
  - Grid arrangement for 3+ services (2-column grid)
  - Named panes using contract `dev.label` or uppercase `name`
  - Tab grouping: all services in a "Development" tab
- [ ] Create `src/execution/template.ts` — Template resolution
  - Read `.kdl.template` files from `env/execution/`
  - Substitute `${VAR}` using resolved pool (reuse `resolveVariables` pattern)
  - Write resolved `.kdl` to same directory (gitignored)
- [ ] Create `src/execution/index.ts` — Public API
  - `ExecutionManager` class
  - `generateFromContracts(profile, pool)` — auto-generate layout
  - `resolveTemplate(templatePath, pool)` — resolve a custom template
  - `getLayoutPath(profile)` — determine which layout to use
- [ ] Export from `src/index.ts` (dynamic import pattern, like vault)

### Phase 3: `ce start` CLI Command

- [ ] Create `cli/commands/start.ts`
  - `ce start [profile]` — positional arg for profile name (default: "default")
  - `--layout <name>` — use a specific template from `env/execution/`
  - `--session <name>` — override Zellij session name
  - `--dry-run` — generate layout file but don't launch Zellij
  - `--no-build` — skip auto-build step
- [ ] Implement command flow:
  1. Resolve profile (same pattern as `ce run`)
  2. Build env (`ce build` logic — reuse `EnvironmentBuilder`)
  3. Determine layout source:
     - `--layout` flag → load `env/execution/{name}.kdl.template`
     - No flag → check `env/execution/{profile}.kdl.template`
     - No template → auto-generate from contracts with `dev` fields
  4. Resolve variables in layout
  5. Write final `.kdl` to `env/execution/{profile}.kdl`
  6. Check Zellij is installed (`which zellij`)
  7. Kill existing session `ce-{profile}` if running
  8. Launch: `zellij --new-session-with-layout <path> --session ce-{profile}`
- [ ] Register in `cli/index.ts`
- [ ] Add to `ce --help` output

### Phase 4: Scaffolding & Init Integration

- [ ] Update `ce init` to create `env/execution/` directory
- [ ] Update `ce init --examples` to include a sample `.kdl.template`
- [ ] Add `env/execution/*.kdl` (not `.template`) to gitignore pattern in init
- [ ] Update `ce uninstall` to clean up `env/execution/` generated `.kdl` files
- [ ] Add `env/execution/` to turbo.json `globalDependencies` pattern (if turborepo detected)

### Phase 5: Script Generation Integration

- [ ] Update `ce scripts` to generate `env:start:<app>` scripts alongside existing patterns
  - `"env:start": "ce start"` — start all services with default profile
  - `"env:start:production": "ce start production"` — start with named profile
- [ ] Track new scripts in `ManagedJsonRegistry`

### Phase 6: Documentation & Examples

- [ ] Create `examples/fullstack/env/execution/default.kdl.template` — example layout
- [ ] Update README.md with execution folder section
- [ ] Update AGENTS.md with execution folder in code structure
- [ ] Update `.claude/skills/turborepo-integration/SKILL.md` with env:start scripts
- [ ] Create `.claude/skills/execution/SKILL.md` — skill doc for execution addon

### Verification

- [ ] `npm run build` compiles clean
- [ ] `npm test` passes (no regressions)
- [ ] `ce start --dry-run` generates valid KDL from example contracts
- [ ] `ce start` launches Zellij session (manual test on machine with Zellij)
- [ ] `ce start` with `--layout` flag uses custom template
- [ ] `ce start` auto-builds if `.ce.*` files missing
- [ ] `ce start` kills stale session before relaunching
- [ ] `ce init --examples` scaffolds execution folder
- [ ] `ce uninstall --dry-run` lists generated `.kdl` files
- [ ] Contracts without `dev` field are silently skipped (no layout pane)
- [ ] Missing Zellij binary gives clear error message

## Files Affected

| File | Change |
|------|--------|
| `src/contracts.ts` | Add `dev` field to `ServiceContract` interface |
| `src/types.ts` | Add Zod schema for `dev` field (optional) |
| `src/execution/kdl.ts` | New — KDL layout generation |
| `src/execution/template.ts` | New — Template variable resolution |
| `src/execution/index.ts` | New — ExecutionManager public API |
| `src/index.ts` | Export execution module (dynamic import) |
| `cli/commands/start.ts` | New — `ce start` command |
| `cli/index.ts` | Register start command |
| `cli/commands/init.ts` | Scaffold `env/execution/` |
| `cli/commands/uninstall.ts` | Clean up generated `.kdl` files |
| `cli/commands/script.ts` | Generate `env:start` scripts |
| `examples/fullstack/env/contracts/*.json` | Add `dev` fields |
| `examples/fullstack/env/execution/` | New — example templates |
| `README.md` | Execution folder docs |
| `AGENTS.md` | Code structure update |

## Dependencies

- Zellij 0.40+ must be installed on the developer's machine (system dependency, not npm)
- No new npm dependencies — KDL generation is string building (not a parser)
- Contract `dev` field is additive — existing contracts without it continue to work unchanged
- Phases 1-2 can be built and tested without Zellij installed (dry-run mode)

## Notes

- **KDL generation vs parsing**: We're *generating* KDL, not parsing it. This means we don't need a KDL parser library — string templates are sufficient and avoid a dependency. If we later need to *read* user-authored KDL, we'd add a parser then.
- **Layout algorithm**: The auto-generated layout for 2 services uses a horizontal split. For 3+ services, a 2-column grid. For 6+ services, consider tabs. This is a heuristic — teams will likely customize.
- **Template vs static KDL**: `.kdl.template` files have `${VAR}` placeholders and get resolved. Plain `.kdl` files are used as-is. This lets teams start with templates and graduate to static files if they don't need variable substitution.
- **Session naming convention**: `ce-{profile}` keeps it short. Could conflict if multiple projects use the same profile name — consider `ce-{project-name}-{profile}` if this becomes an issue (project name from package.json).
- **Open question**: Should `ce start` also support a `--attach` flag to attach to an existing session instead of launching a new one? Useful for reconnecting after terminal close. Defer to v2.
- **Open question**: Should execution templates support conditional panes (only include a pane if a certain variable is set)? This adds complexity — defer unless there's clear demand.
