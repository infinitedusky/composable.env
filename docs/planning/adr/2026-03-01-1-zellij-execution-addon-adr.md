---
title: "ADR: Zellij Execution Folder Addon"
date: 2026-03-01
status: proposed
---

# ADR: Zellij Execution Folder Addon

## Y-Statement

In the context of **multi-service local development environments**,
facing **the need to launch every service simultaneously in a visible, debuggable terminal layout**,
we decided for **a contract-driven KDL layout generator with a `ce start` command that builds env, generates layouts from templates, and launches Zellij sessions**
and against **a generic process manager (PM2/foreman), a Docker Compose-only approach, and a tmux-based solution**,
to achieve **single-command full dev environment startup that reuses composable.env's existing contract and profile system**,
accepting **a hard dependency on Zellij for the terminal multiplexer and KDL as the layout format**,
because **Zellij's named-pane layout model maps naturally to service contracts, KDL is its native format, and the execution folder pattern is already proven in production use**.

## Context

composable.env solves environment variable composition — building `.ce.*` files from components, profiles, and contracts. But the next step after `ce build` is actually *running* the services. Today that's manual: developers open multiple terminals, cd into service directories, and run commands individually. Or they use hand-rolled shell scripts that duplicate knowledge composable.env already has.

The brief describes a proven pattern from an existing project where:
- An `env/execution/` folder contains Zellij KDL layout templates
- A shell script does `sed` substitution on templates, then launches Zellij
- Each pane starts one service, logs to a file, tails it live
- One command (`env:start <profile>`) brings up the entire dev environment

The problem: the existing approach is hand-rolled per project. It manually maps profile names to template files, uses `sed` for variable substitution (ignoring composable.env's own `${VAR}` system), and has no awareness of which services a profile actually needs.

composable.env already knows:
- Which contracts are active for a profile (via `ContractManager.getContracts()`)
- Each service's name and location (via `ServiceContract.name` and `ServiceContract.location`)
- The full resolved variable pool (via `EnvironmentBuilder.buildFromProfile()`)

This makes it the natural place to generate layouts.

## Decision

### Optional addon architecture

The Zellij integration is an **optional addon** — a separate module (`src/execution/`) that is only loaded when invoked via `ce start`. It follows the same pattern as the vault: dynamically imported, with clear error messages if dependencies (Zellij binary) are missing.

### Contract extension: `dev` field

Contracts gain an optional `dev` field that declares how to run the service locally:

```json
{
  "name": "api",
  "location": "apps/api",
  "required": { ... },
  "dev": {
    "command": "pnpm dev",
    "cwd": "apps/api",
    "label": "API Server"
  }
}
```

- `command` — the shell command to run in the pane
- `cwd` — working directory (defaults to `location`)
- `label` — pane display name (defaults to uppercase `name`)

Services without a `dev` field are skipped during layout generation (env-only contracts like shared libraries).

### Execution folder: `env/execution/`

Contains KDL layout files — both templates (`.kdl.template`) and custom static layouts (`.kdl`):

```
env/execution/
  default.kdl.template    # Auto-generated from contracts
  local-docker.kdl        # Hand-crafted custom layout
```

Templates use composable.env's standard `${VAR}` syntax and are resolved using the same variable pool as `ce build`. Generated `.kdl` files are gitignored.

### `ce start` command

```bash
ce start                          # default profile, auto-generated layout
ce start production               # production profile
ce start --layout local-docker    # custom layout file
```

The command:
1. Runs `ce build` for the profile (reuses existing auto-build logic)
2. Resolves the layout — auto-generates from contracts or uses a specified template
3. Substitutes `${VAR}` placeholders using the resolved pool
4. Writes the final `.kdl` to `env/execution/{profile}.kdl`
5. Kills any existing Zellij session with the same name
6. Launches `zellij --new-session-with-layout <path> --session ce-{profile}`

### KDL generation from contracts

When no custom layout exists, `ce start` auto-generates a KDL layout:

```kdl
layout {
    tab name="Development" {
        pane split_direction="vertical" {
            pane name="API Server" {
                command "bash"
                args "-c" "cd apps/api && pnpm dev"
            }
            pane name="Worker" {
                command "bash"
                args "-c" "cd apps/worker && pnpm dev"
            }
        }
    }
}
```

The layout algorithm:
- One pane per contract that has a `dev` field
- Panes split vertically by default (side-by-side for 2, grid for 3+)
- Optional: a dedicated log pane tailing all services

### Session naming

Zellij sessions are named `ce-{profile}` (e.g., `ce-default`, `ce-production`). This allows:
- `ce start` to kill a stale session before launching
- Multiple profiles to run simultaneously in separate sessions
- Easy identification in `zellij list-sessions`

## Alternatives Considered

### PM2 / foreman / Procfile-based process manager

Process managers run services but don't provide a visible terminal layout. Developers can't see service output side-by-side, can't interact with individual services (attach a debugger, restart one), and lose the "dashboard" feel. PM2 also introduces its own process lifecycle that conflicts with Ctrl+C workflows.

### Docker Compose for everything

composable.env already supports Docker Compose generation via profile `docker` blocks. But Docker Compose is for containerized services — many local dev workflows mix native processes (Next.js dev server) with Docker services (PostgreSQL). The execution folder handles the native-process side.

### tmux instead of Zellij

tmux is more ubiquitous but has a worse layout DSL (shell scripting vs KDL), no native named panes, and requires more scripting to achieve the same result. Zellij's layout-file-first model maps directly to what we need. The prior art in the brief already uses Zellij successfully.

### Embed layout config in profile JSON

Instead of separate KDL files, layouts could be declared in profile JSON. Rejected because: KDL is Zellij's native format, allows copy-paste from Zellij docs, and custom layouts often need features (floating panes, tab groups) that would be painful to express in JSON. The execution folder keeps layout concerns separate from env composition.

## Consequences

### Positive
- Single-command dev environment startup: `ce start` replaces multi-step manual setup
- Contracts become the source of truth for both env vars AND how to run services
- Variable substitution in layouts reuses the existing `${VAR}` system — no separate `sed` step
- Custom layouts coexist with auto-generated ones — teams can start generated and customize later
- No new runtime dependencies in the core package (Zellij is a system binary, not an npm dep)

### Negative
- Hard dependency on Zellij being installed — won't work with tmux/screen users without adapter work
- KDL is Zellij-specific — layouts aren't portable to other terminal multiplexers
- Contract `dev` field adds schema surface area that's irrelevant to env-var-only use cases
- Auto-generated layouts may not match team preferences — most will need customization

### Risks
- **Zellij version churn**: KDL layout syntax has changed between Zellij versions. Mitigate by targeting Zellij 0.40+ (stable layout format) and documenting minimum version.
- **Platform support**: Zellij runs on Linux/macOS but not Windows natively. Document WSL as the Windows path.
- **Session cleanup**: If `ce start` crashes mid-launch, orphaned Zellij sessions may linger. Mitigate with `--force-run` flag and clear error messages.

## References

- Zellij layout documentation: https://zellij.dev/documentation/layouts
- KDL specification: https://kdl.dev
- composable.env contracts: `src/contracts.ts` — `ServiceContract` interface
- composable.env builder: `src/builder.ts` — `buildFromProfile()`, `resolveVariables()`
- Existing execution folder pattern: described in brief (capacitr project)
