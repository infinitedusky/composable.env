---
title: "ADR v1: Service Registration SDK via Manifest-Driven Sync"
date: 2026-03-02
status: proposed
---

# ADR v1: Service Registration SDK via Manifest-Driven Sync

## Y-Statement

In the context of **a growing monorepo with many services and profile-specific runtime behavior**,
facing **manual registration across env components, service interfaces, profiles, scripts, KDL templates, and Docker build scripts**,
we decided for **a manifest-first service registration model with `ce service sync` that generates downstream artifacts**,
and against **manual multi-file registration and implicit conventions spread across unrelated layers**,
to achieve **single-source-of-truth service onboarding with consistent validation and deterministic code generation**,
accepting **a new manifest schema and generator layer in composable.env**,
because **service definitions should be declared once and compiled into contracts, scripts, execution metadata, and build inputs**.

## Context

Adding a service currently requires editing 6+ files in different formats:

- `env/components/*.env`
- `env/services/*.interface.ts`
- `env/profiles/*.json`
- `env/execution/*.kdl.template`
- root `package.json`
- `scripts/docker/build-all-parallel.sh`

This creates drift risk and no enforcement of cross-layer consistency.

The monorepo also has profile-dependent runtime behavior:

- The same service may run as Docker in `local-docker` but native/PM2 in `local-dev`.
- Some panes should be present but suspended by default.

The build pipeline has two distinct concerns:

1. TypeScript compilation scope (Turbo filters)
2. Docker image build/push orchestration

The second concern includes domain-specific machine orchestration and should not be absorbed wholesale into a generic SDK.

## Decision

### 1. Service manifests are source of truth

Introduce one manifest file per service (for example `env/services/emergeables.service.json`) including:

- identity: `name`, `type`, `location`, `port`
- env mapping: `env.required`, `env.optional`, `env.defaults`
- execution: `execution.default`, `execution.profiles.<profile>`
- build: `build.included_in_prod`, `build.docker`

### 2. Env schema has no separate `secret` block

Manifest env mapping intentionally uses only:

- `required`
- `optional`
- `defaults`

Rationale: current `secret` handling is functionally equivalent to required for validation, resolution, and output destination. Secret semantics can return later as per-variable metadata if needed.

### 3. Execution is resolved per profile

Execution resolution rule for generation:

1. Use `execution.profiles[profileName]` when present
2. Otherwise use `execution.default`

Execution override supports:

- `mode` (`native` | `docker` | `pm2`)
- `command`
- `kill_port`
- `suspended` (maps to Zellij `start_suspended`)

### 4. `ce service sync` generates downstream artifacts

From manifests, `ce service sync` will generate:

- env contracts (`env/contracts/*.contract.json`)
- package scripts (`dev:<service>`, `build:<service>`, `<action>:all`)
- KDL generation inputs/layout artifacts (phase 2)
- Turbo filter inputs from `build.included_in_prod`
- Docker build matrix from `build.docker.enabled`

### 5. Boundary: ce generates inputs, domain scripts orchestrate specialized builds

`ce` will not absorb machine-specific orchestration (GPU tiers, custom node installs, encrypted payload workflows). Instead:

- `ce` provides generated env/build metadata and matrices
- domain scripts consume generated artifacts
- `build.docker.prepare_script` allows opt-in custom build preparation

### 6. Proposed command surface

- `ce service add <name> --type ... --location ... --port ...`
- `ce service sync [--profile <name>]`
- `ce service validate`
- existing: `ce scripts:sync`
- existing: `ce scripts:register <names...>`

## Consequences

### Positive

- New service onboarding becomes one manifest file, not 6+ manual edits.
- Profile-specific runtime behavior becomes explicit and testable.
- Build include/exclude and Docker eligibility are derived, not hand-maintained.
- Uninstall/cleanup safety remains compatible via managed-key registration.

### Negative

- Introduces a larger schema surface that must be versioned carefully.
- Generator bugs can affect multiple derived artifacts at once.
- Teams must migrate existing interfaces/templates into manifests.

### Risks

- Transition period with mixed old/new systems can create ambiguity.
- Incorrect naming conventions (`image`, location, package mapping) can generate wrong build targets.
- Validation must be strict enough to catch conflicts early (ports, modes, mappings) without blocking legitimate advanced workflows.

## Validation Requirements (`ce service validate`)

- Duplicate service names
- Port collisions within a profile's effective execution set
- Missing or invalid `location`
- Invalid env mappings
- Profile/service mode conflicts (docker/native/pm2 mismatch)

## Phased Delivery

- **Phase 1A**: manifest schema + `ce service sync` for contracts/scripts (`:all` included)
- **Phase 1B**: Turbo filter generation + Docker build matrix generation
- **Phase 2**: KDL generation from execution config + layout skeletons

## References

- Existing planning ADR: `docs/planning/adr/2026-03-01-1-zellij-execution-addon-adr.md`
- Existing implementation plan: `docs/planning/impl/2026-03-01-1-zellij-execution-addon-impl.md`
- Current contracts implementation: `src/contracts.ts`
- Current script generation: `cli/commands/script.ts`
