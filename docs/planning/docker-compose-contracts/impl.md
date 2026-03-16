---
title: "Contract target — write into docker-compose.yml"
date: 2026-03-16
status: completed
---

# Contract target — write into docker-compose.yml

## Goal

Allow contracts to write resolved vars directly into a docker-compose.yml service's `environment:` block via a new `target` field. The compose file becomes a gitignored build artifact — contracts are the versioned source of truth.

## Scope

### In Scope
- New `target` field on contracts (`type`, `file`, `service`)
- YAML read-modify-write: parse compose file, update target service's `environment:`, write back
- Multiple contracts targeting the same compose file (sequential updates)
- Create file/service entry if missing
- Contract validation: `target` and `location` are mutually exclusive
- SKILL.md guidance

### Out of Scope
- Preserving YAML comments (standard YAML libs don't support this — accepted tradeoff)
- Docker Compose generation from profiles (existing `profile.docker` feature, unchanged)
- Running `docker compose up` from `ce start` (future enhancement)
- Target types other than `docker-compose` (future: could support other file formats)

## Checklist

### Phase 1: Contract schema
- [x] Add `ContractTarget` type to `src/contracts.ts`: `{ type: 'docker-compose', file: string, service: string }`
- [x] Add optional `target` field to `ServiceContract` interface
- [x] Validate mutual exclusivity: contract must have `location` OR `target`, not both, not neither
- [x] Validate target type is `docker-compose` and has required `file` + `service` fields
- [x] Export `ContractTarget` from `src/index.ts`

### Phase 2: Docker Compose writer
- [x] Create `src/targets/docker-compose.ts` with `writeDockerComposeEnvironment()` — read YAML, update service environment, write back
- [x] Use the `yaml` package already in dependencies for parse/stringify
- [x] Create file if missing, create service entry if missing
- [x] Add header comment with profile and build timestamp

### Phase 3: Builder integration
- [x] Import `writeDockerComposeEnvironment` in `builder.ts`
- [x] In `buildServiceEnvironments`, handle `target` contracts separately from `location` contracts
- [x] For each `target` contract: resolve vars (same pipeline), then call `writeDockerComposeEnvironment()`
- [x] Track written compose files in `generatedFiles` for output
- [x] Group contracts by target file to process sequentially

### Phase 4: Ecosystem / ce start awareness
- [x] In `ecosystem.ts extractApps()`: skip contracts with `target` and no `location` (container-managed, not PM2)

### Phase 5: Skill + documentation
- [x] Add docker-compose target section to SKILL.md with example contract and output
- [x] Document that docker-compose.yml should be gitignored when using targets
- [x] Add anti-pattern: don't copy composable.env into containers
- [x] Add guidance: use `target` for Docker Compose services

### Verification
- [ ] Contract with `target: { type: "docker-compose", file: "docker-compose.yml", service: "engine" }` writes resolved vars into compose file
- [ ] Multiple contracts targeting same compose file — each service gets its own vars
- [ ] Contract with `location` still writes `.env.{profile}` (no regression)
- [ ] Missing compose file gets created
- [ ] Missing service entry gets created in existing compose file
- [ ] Non-target services in compose file are untouched
- [ ] Contract with both `location` and `target` fails validation
- [ ] Custom `envDir` doesn't affect target paths (targets are relative to project root)

## Files Affected

| File | Change |
|------|--------|
| `src/contracts.ts` | Add `ContractTarget` type, `target` field on `ServiceContract`, mutual exclusion validation |
| `src/targets/docker-compose.ts` | New file — YAML read-modify-write for compose files |
| `src/builder.ts` | Import target writer, handle `target` contracts in `buildServiceEnvironments` |
| `src/execution/ecosystem.ts` | Skip `target`-only contracts in `extractApps()` |
| `src/index.ts` | Export `ContractTarget` type |
| `skills/SKILL.md` | Docker-compose target section, anti-patterns, guidance |

## Dependencies

- `yaml` package (already in dependencies — used by existing `generateDockerCompose`)

## Notes

- The `target.type` field future-proofs for other output formats. Only `docker-compose` is implemented now.
- YAML stringify won't preserve comments from the original file. Since the compose file is gitignored (build artifact), this is acceptable — it's not hand-maintained.
- Processing order: contracts targeting the same file are grouped and processed sequentially.
