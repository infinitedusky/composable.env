---
title: "Multi-profile Docker Compose output with YAML anchors"
date: 2026-03-16
status: proposed
---

# Multi-profile Docker Compose output with YAML anchors

## Y-Statement

In the context of **Docker Compose target generation**,
facing **the need to switch between environments (local, production) without rebuilding the compose file each time**,
we decided for **generating all profiles into a single compose file using `x-` YAML anchors for shared Docker config and Docker Compose `profiles:` for per-environment service variants**
and against **generating one compose file per ce profile (current behavior) or a per-profile override file (`docker-compose.{profile}.yml`)**,
to achieve **instant environment switching via `docker compose --profile local up` with zero config duplication**,
accepting **`ce build` must now iterate all profiles for target contracts (slower build), service names get profile suffixes (e.g., `numero-local`, `numero-production`), and the `yaml` library must use its Document API for anchor/alias support**,
because **ce profiles should map directly to Docker Compose profiles — one concept, one behavior — and YAML anchors eliminate the duplication of Docker config (image, ports, volumes, healthchecks) that would otherwise be repeated per profile variant**.

## Context

Currently `ce build local` generates a `docker-compose.yml` with local-resolved environment variables. Running `ce build production` overwrites it with production values. You can't have both environments available simultaneously — switching requires a full rebuild.

Docker Compose natively supports `profiles:` on services, allowing `docker compose --profile local up` vs `docker compose --profile production up` from a single file. This maps cleanly to ce's existing profile concept.

The challenge is Docker config duplication. If a service `numero` needs the same image, ports, volumes, and healthcheck in both local and production — only the `environment:` block differs — duplicating the entire service definition per profile is wasteful and error-prone. YAML anchors (`x-` extensions with `<<: *anchor` merge keys) solve this natively.

### Current behavior

```
ce build local      → docker-compose.yml (local vars only)
ce build production → docker-compose.yml (production vars, overwrites local)
```

### New behavior

```
ce build            → docker-compose.yml (ALL profiles, anchored shared config)
docker compose --profile local up       → starts local variant
docker compose --profile production up  → starts production variant
```

## Decision

### 1. `ce build` generates all profiles when target contracts exist

When any contract has a `target` field, the builder:
1. Discovers all available profiles (from `env/profiles/*.json` + component `[section]` names)
2. For each profile, resolves vars for all target contracts
3. Generates one compose file with all profile variants

Contracts without `onlyProfiles` generate a variant for every profile. Contracts with `onlyProfiles` only generate for those profiles.

### 2. Shared Docker config uses `x-` YAML anchors

For each target service that appears across multiple profiles, the shared config (everything except `environment:` and `profiles:`) is extracted into an `x-{service}` extension block with a YAML anchor:

```yaml
x-numero: &numero-base
  build:
    context: .
    dockerfile: Dockerfile
  ports:
    - "4000:4000"
  volumes:
    - pgdata:/data/postgres
  restart: unless-stopped
```

### 3. Per-profile variants use `<<:` merge and `profiles:`

Each profile variant merges the anchor and adds its resolved environment:

```yaml
services:
  numero-local:
    <<: *numero-base
    profiles: ["local"]
    environment:
      DATABASE_URL: postgresql://localhost:5432/dev

  numero-production:
    <<: *numero-base
    profiles: ["production"]
    environment:
      DATABASE_URL: postgresql://db.prod.internal:5432/app
```

### 4. Services identical across profiles get no `profiles:` array

If a service's config and environment are identical across all profiles (e.g., a standalone Redis), it appears once with no `profiles:` key — Docker Compose starts it regardless of which profile is selected.

### 5. Service naming convention

- Single-profile service: `{service}` (no suffix)
- Multi-profile service: `{service}-{profile}` (e.g., `numero-local`, `numero-production`)

### 6. `.env` file output is NOT affected

The `location`-based `.env.{profile}` output is unchanged. It still requires a specific profile. Only `target`-based compose output becomes multi-profile. A contract with both `location` and `target` writes `.env.{profile}` for the specified profile AND contributes to the multi-profile compose file.

## Alternatives Considered

### Per-profile compose files

Generate `docker-compose.local.yml`, `docker-compose.production.yml` etc. Keeps the current single-profile build logic but produces separate files. Rejected because: Docker Compose's native `--profile` flag is the standard solution, multiple files require `docker compose -f` stacking which is clunky, and there's no DRY mechanism for shared Docker config.

### Override files

Generate a base `docker-compose.yml` with shared config and `docker-compose.{profile}.yml` override files per profile. Rejected because: override merge semantics are complex and surprising (array replacement vs merge varies by key), and the `x-` anchor approach achieves DRY within a single file.

## Consequences

### Positive
- One compose file, all environments — no rebuilding to switch profiles
- ce profiles map directly to Docker Compose profiles — consistent mental model
- YAML anchors eliminate Docker config duplication
- `docker compose --profile <name> up` is the only command needed
- Forwards-compatible with Compose Bridge (select profile before bridging to production)

### Negative
- `ce build` for targets is slower — must resolve vars for every profile, not just one
- Service names get profile suffixes — scripts referencing `numero` must use `numero-local`
- YAML anchor output requires the `yaml` library's Document API — more complex serialization

### Risks
- The `<<:` merge key is technically deprecated in YAML 1.2, but Docker Compose explicitly supports it and it's widely used. If Docker ever drops support, ce can switch to full duplication. Low risk.
- Large numbers of profiles × services could produce a very long compose file. Mitigate by keeping profiles focused.

## References

- [docker-compose.ts](../../src/targets/docker-compose.ts) — current compose writer (single-profile, batch entries)
- [builder.ts:331-507](../../src/builder.ts) — `buildServiceEnvironments` where target contracts are processed
- [Docker Compose profiles docs](https://docs.docker.com/compose/how-tos/profiles/)
- [yaml npm v2 Document API](https://eemeli.org/yaml/#documents) — anchor/alias support
- [docs/planning/docker-compose-contracts/adr.md](../docker-compose-contracts/adr.md) — original target ADR (partially superseded)
