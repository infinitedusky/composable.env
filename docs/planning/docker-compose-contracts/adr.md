---
title: "Contract target — write into docker-compose.yml"
date: 2026-03-16
status: proposed
---

# Contract target — write into docker-compose.yml

## Y-Statement

In the context of **services that run inside Docker Compose**,
facing **the need to supply resolved env vars — including secrets — to containerized services without manual sync**,
we decided for **a `target` field on contracts that points to a docker-compose.yml file and service name, writing resolved vars into that service's `environment:` block**
and against **generating sidecar .env files that docker-compose reads via `env_file:`**,
to achieve **a single gitignored output file (docker-compose.yml) that contains fully resolved environments, built from versioned contracts**,
accepting **cenv must read, parse, mutate, and rewrite YAML — which means comments/formatting may not be perfectly preserved**,
because **the docker-compose.yml becomes a build artifact like `.env.{profile}` — gitignored, contains secrets, rebuilt on every `ce build` — and the contract remains the versioned source of truth**.

## Context

composable.env contracts declare what variables a service needs. Currently, `location` is a directory path and the builder writes `.env.{profile}` there. This works for apps that live on the filesystem.

Docker Compose services don't live at a filesystem path. They're defined in a YAML file, and their env vars belong in the `environment:` block. Rather than generating a sidecar `.env` file and asking the user to wire it up with `env_file:`, cenv should write directly into the compose file.

This makes docker-compose.yml a **build output** — just like `.env.{profile}` files. It gets gitignored because it contains resolved secrets. The contract (versioned in git) is the source of truth for what each service receives.

### Current output model

```
contract (versioned) → ce build → .env.{profile} (gitignored)
```

### New output model

```
contract (versioned) → ce build → docker-compose.yml environment block (gitignored)
```

Same pattern, different output target.

## Decision

Add an optional `target` field to contracts as an alternative to `location`:

```json
{
  "name": "engine",
  "target": {
    "type": "docker-compose",
    "file": "docker-compose.yml",
    "service": "engine"
  },
  "vars": {
    "PORT": "${engine.PORT}",
    "ENCRYPTION_PASSWORD": "${secrets.ENCRYPTION_PASSWORD}",
    "POSTGRES_CONNECTION_URL": "${database.URL}"
  }
}
```

When the builder encounters a contract with `target`:

1. Read and parse the YAML file at `target.file`
2. Find `services.{target.service}`
3. Set/replace its `environment:` block with the resolved vars (as a key-value map)
4. Write the file back

If the file doesn't exist yet, create it with just that service's entry. If the service doesn't exist in the file, add it.

A contract has either `location` (write .env file) or `target` (write into a target file). Not both.

### Output format

The `environment:` block uses the map syntax (not array):

```yaml
services:
  engine:
    image: thirdweb/engine:latest
    environment:
      PORT: "3005"
      ENCRYPTION_PASSWORD: "resolved-value-here"
      POSTGRES_CONNECTION_URL: "postgresql://postgres@db:5432/engine"
```

cenv only touches the `environment:` key for its target service. Everything else in the compose file (image, ports, volumes, depends_on, other services) is left untouched.

### Multiple contracts, same file

Multiple contracts can target the same docker-compose.yml with different services:

```
engine.contract.json   → target: { file: "docker-compose.yml", service: "engine" }
postgres.contract.json → target: { file: "docker-compose.yml", service: "postgres" }
redis.contract.json    → target: { file: "docker-compose.yml", service: "redis" }
```

The builder processes them sequentially, each updating their service's `environment:` block.

## Alternatives Considered

### Sidecar .env files with env_file: directive

Generate `.env.engine.{profile}` and have docker-compose read it via `env_file:`. This works but adds indirection — two files to keep in sync, and the user must manually add the `env_file:` line. The compose file also can't be gitignored since it's hand-authored, meaning secrets must live in separate files.

### Full docker-compose.yml generation from profiles

Already partially exists via `profile.docker`. Forces the user to define their entire compose config inside cenv's profile JSON — ports, volumes, healthchecks all in JSON rather than YAML. Unnatural and limits compose features.

## Consequences

### Positive
- docker-compose.yml is a build artifact — gitignored, contains secrets, rebuilt on `ce build`
- Contract is the single versioned source of truth
- No indirection — vars are right there in the compose file
- Same mental model as .env file output, just a different target
- Compose file can contain non-cenv services too — cenv only touches what it owns

### Negative
- YAML read-modify-write may not preserve comments or exact formatting
- More complex than writing flat .env files — YAML parsing and selective mutation

### Risks
- Concurrent writes if multiple contracts target the same file — mitigate by processing sequentially within a single build
- User edits to `environment:` blocks get overwritten on next build — document clearly that cenv owns those blocks

## References

- [builder.ts:408-428](../../src/builder.ts) — current contract output path logic
- [contracts.ts ServiceContract](../../src/contracts.ts) — contract interface with `location` field
- [types.ts DockerComposeSchema](../../src/types.ts) — existing docker-compose type definitions
