---
title: "Impl v1: Service Registration SDK via Manifest-Driven Sync"
date: 2026-03-02
status: draft
adr: v1-2026-03-02-1-service-registration-sdk-adr.md
---

# Impl v1: Service Registration SDK via Manifest-Driven Sync

## Goal

Implement a service manifest system where `ce service sync` compiles one service definition into generated contracts, scripts, execution/build metadata, and validation outputs.

## Scope

### In Scope

- Manifest schema (`env/services/*.service.json`)
- `ce service sync` command
- `ce service validate` command
- Contract generation from manifests
- Script generation from manifests, including `<action>:all`
- Turbo filter artifact generation from `build.included_in_prod`
- Docker build matrix generation from `build.docker.enabled`
- Optional `prepare_script` metadata passthrough

### Out of Scope

- Replacing domain-specific machine build orchestration
- GPU-tier/custom-node build logic
- Full KDL replacement in phase 1 (deferred to phase 2)
- Dependency conflict auto-resolution for `shamefully-hoist`

## Manifest Schema (v1)

```json
{
  "name": "emergeables",
  "type": "nextjs-frontend",
  "location": "apps/emergeables",
  "port": 3000,
  "env": {
    "required": {},
    "optional": {},
    "defaults": {}
  },
  "execution": {
    "default": {
      "mode": "native",
      "command": "pnpm -w dev:emergeables --env ${PROFILE}",
      "kill_port": true,
      "suspended": false
    },
    "profiles": {
      "local-docker": {
        "mode": "docker",
        "command": "docker compose up emergeables",
        "kill_port": false,
        "suspended": false
      }
    }
  },
  "build": {
    "included_in_prod": true,
    "docker": {
      "enabled": false,
      "image": "emprops/emergeables",
      "prepare_script": "prepare-docker-build.js"
    }
  }
}
```

Notes:

- No separate `env.secret` field in v1.
- `execution.profiles[profile]` overrides `execution.default`.
- `suspended` is retained for phase-2 KDL generation.

## Generated Artifacts

### Phase 1A

- `env/contracts/<service>.contract.json`
- managed root scripts in `package.json`:
  - `dev:<service>`, `build:<service>`, `start:<service>` (action set configurable)
  - `dev:all`, `build:all`, `start:all`
  - optional compatibility aliases (`dev`, `build`, `start`)

### Phase 1B

- Turbo build filter artifact (example):
  - `env/generated/turbo.build-prod.filters.json`
- Docker build matrix artifact (example):
  - `env/generated/docker.build-matrix.json`

### Phase 2

- Generated layout/template artifacts under `env/execution/` from `execution.*`.

## Checklist

### Phase 1A: Manifest + Contracts/Scripts

- [ ] Add manifest Zod schema/types in `src/types.ts`
- [ ] Add manifest loader/validator module (`src/services.ts` or equivalent)
- [ ] Implement `ce service sync` command in `cli/commands/service.ts`
- [ ] Generate `env/contracts/*.contract.json` from manifests
- [ ] Integrate script generation from manifests
- [ ] Ensure generated scripts are tracked in `ManagedJsonRegistry`
- [ ] Add `ce service validate` baseline checks
- [ ] Register command in `cli/index.ts`
- [ ] Update README command reference and workflow docs

### Phase 1B: Build Orchestration Inputs

- [ ] Add `build` schema support (`included_in_prod`, `docker.enabled`, `image`, `prepare_script`)
- [ ] Generate Turbo filter artifact from manifest set
- [ ] Generate Docker build matrix artifact from manifest set
- [ ] Decide and document `CURRENT_ENV` strategy for `build:docker:all <profile>`
- [ ] Document integration contract for domain scripts consuming generated artifacts

### Phase 2: KDL Generation

- [ ] Extend execution generator to consume manifest execution config directly
- [ ] Implement `suspended` mapping to Zellij `start_suspended`
- [ ] Support profile-specific runtime mode switching (docker/native/pm2)
- [ ] Preserve `${PROJECT_ROOT}` and `${PROFILE}` substitution semantics
- [ ] Migrate away from hand-authored `.kdl.template` maintenance where possible

## Validation Rules (`ce service validate`)

- [ ] Duplicate service names
- [ ] Port collisions per profile-effective execution config
- [ ] Missing/invalid service location
- [ ] Invalid env mappings
- [ ] Profile/service mode conflicts
- [ ] Docker config consistency (`enabled` with missing image policy)

## File-Level Plan

- `src/types.ts`
  - add manifest schemas and TS types
- `src/index.ts`
  - export manifest/service loader APIs
- `cli/commands/service.ts` (new)
  - `ce service add`, `ce service sync`, `ce service validate`
- `cli/index.ts`
  - register new service command
- `cli/commands/script.ts`
  - optionally reuse internals for script write/managed registration
- `README.md`
  - add manifest model + command docs
- `examples/fullstack/`
  - add sample manifest(s)

## Testing Strategy

- Unit:
  - manifest schema validation
  - profile execution override resolution
  - contract generation snapshot tests
  - script generation snapshot tests
  - turbo/docker artifact generation snapshot tests
- Integration:
  - `ce service sync` on example repo fixture
  - `ce service validate` failure cases
  - uninstall removes generated managed scripts cleanly

## Rollout Plan

1. Land phase 1A behind additive commands (no breaking behavior)
2. Migrate a subset of services to manifests and verify parity
3. Land phase 1B artifacts and switch domain scripts to consume generated outputs
4. Land phase 2 KDL generation and remove manual template drift paths

## Open Decisions

- Canonical output path/naming for generated Turbo/Docker artifacts
- Whether `build:all` aliases should remain default-profile-only or profile-positional
- Policy for docker image default naming when `build.docker.image` is omitted
- Whether `ce service sync` should remove stale generated contracts/scripts for deleted manifests in v1 or require explicit prune mode
