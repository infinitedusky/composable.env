---
title: "Multi-profile Docker Compose output with YAML anchors"
date: 2026-03-16
status: draft
---

# Multi-profile Docker Compose output with YAML anchors

## Goal

Generate a single `docker-compose.yml` containing all ce profiles, using YAML anchors for shared Docker config and Docker Compose `profiles:` for per-environment service variants. Users switch environments with `docker compose --profile local up` instead of rebuilding.

## Scope

### In Scope
- New multi-profile compose writer using `yaml` Document API for anchors
- Builder changes to iterate all profiles when target contracts exist
- Service deduplication (identical across profiles → no `profiles:` array)
- Naming convention: `{service}-{profile}` for multi-profile variants
- `onlyProfiles` filtering respected per profile iteration
- Update SKILL.md with multi-profile usage docs

### Out of Scope
- Changes to `.env.{profile}` output (location-based contracts unchanged)
- `ce build --profile` still works for location-only builds
- Process Compose integration (future)
- Compose Bridge integration (future)

## Checklist

### Phase 1: Multi-profile compose writer
- [ ] Add `ComposeMultiProfileEntry` type — extends `ComposeServiceEntry` with `profileName`
- [ ] Create `writeMultiProfileComposeFile()` in `src/targets/docker-compose.ts`
  - Groups entries by target service name
  - Detects if a service varies across profiles (different env vars) vs is identical
  - For varying services: extracts shared config into `x-{service}` anchor, writes `{service}-{profile}` variants with `<<: *{service}-base` merge + `profiles: ["{profile}"]` + per-profile `environment:`
  - For identical services: writes single entry with no `profiles:` key
  - Preserves existing behavior: auto-gitignore, non-generated file guard, var collision warnings, top-level volumes/networks detection
- [ ] Use `yaml` library's `Document`, `YAMLMap`, and `Alias` classes for proper anchor/alias output

### Phase 2: Builder changes
- [ ] Add `buildAllProfiles()` public method to `EnvironmentBuilder`
  - Discovers all profiles via `listProfiles()` + component section scan
  - For each profile: resolves component pool, maps target contract vars
  - Collects `ComposeMultiProfileEntry[]` across all profiles
  - Calls `writeMultiProfileComposeFile()` once per target file
  - Still writes `.env.{profile}` for location-based contracts (only for the requested profile)
- [ ] Update `buildFromProfile()` to call `buildAllProfiles()` when target contracts exist
- [ ] Handle `onlyProfiles` filtering per-profile iteration (contract skipped for profiles it doesn't match)

### Phase 3: CLI changes
- [ ] `ce build` (no profile arg) generates multi-profile compose + `.env.{defaultProfile}` for location contracts
- [ ] `ce build --profile X` generates multi-profile compose + `.env.X` for location contracts
- [ ] Log which profiles were included in the compose output

### Phase 4: Example & docs
- [ ] Update `examples/docker-compose/` — add a second profile, show anchor output
- [ ] Update `skills/SKILL.md` — multi-profile compose section, usage examples
- [ ] Update `AGENTS.md` if needed

### Verification
- [ ] `ce build` in example project produces compose file with `x-` anchors and `profiles:` arrays
- [ ] `docker compose --profile local config` validates successfully
- [ ] `docker compose --profile production config` validates successfully
- [ ] Service with identical config+vars across profiles appears once without `profiles:` key
- [ ] `onlyProfiles` contract appears only in matching profile variants
- [ ] Location-based `.env.{profile}` output unchanged
- [ ] `pnpm build` compiles cleanly

## Files Affected

| File | Change |
|------|--------|
| `src/targets/docker-compose.ts` | Add `writeMultiProfileComposeFile()`, `ComposeMultiProfileEntry` type |
| `src/builder.ts` | Add `buildAllProfiles()`, modify `buildFromProfile()` to detect targets |
| `cli/commands/build.ts` | Update to handle multi-profile output, adjust logging |
| `skills/SKILL.md` | Add multi-profile compose docs |
| `examples/docker-compose/` | Add second profile, update contracts if needed |
| `package.json` | Bump to 1.4.0 |

## Dependencies

- `yaml` v2.x — already installed, supports `Document` API with anchors/aliases via `createNode()`, `Pair`, `Scalar`, `Alias` classes
- Existing `writeDockerComposeFile()` — kept for backwards compat, `writeMultiProfileComposeFile()` is the new primary path

## Notes

- **The `<<:` merge key**: YAML 1.2 deprecated it, but Docker Compose explicitly supports it and recommends it in their docs. It's the idiomatic way to share config in compose files. If `yaml` v2 doesn't emit `<<:` natively, we can construct it manually using `Pair` with a `Scalar('<<')` key and an `Alias` value.
- **Profile discovery**: The builder already has `listProfiles()` for JSON profiles and `profileSectionExists()` for component sections. For multi-profile compose, we need a unified list. `listProfiles()` returns JSON profiles; component section scanning adds implicit ones. Consider a `discoverAllProfiles()` method.
- **Build performance**: For N profiles × M target contracts, the builder resolves vars N×M times. For typical projects (2-4 profiles, 5-10 contracts) this is negligible. Only matters at scale.
- **`container_name` in anchors**: If the shared config includes `container_name`, it would conflict across profile variants (two services can't have the same container name). The anchor extraction should exclude `container_name` or make it profile-aware.
