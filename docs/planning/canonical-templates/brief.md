# Brief: canonical infrastructure templates

Bookmarked 2026-05-11. Pattern emerged from the Caddy auto-emit work
(v1.24.4). composable.env increasingly ships "this is how we recommend
running X" templates — app Dockerfiles AND infrastructure containers.
This brief captures the broader direction so future additions are
consistent.

## Current state

What composable.env ships today as turnkey templates:

| Template | Form | Trigger |
|----------|------|---------|
| `Dockerfile.nextdev` | Scaffolded file | `ce init --scaffold docker` |
| `Dockerfile.nextprod` | Scaffolded file | `ce init --scaffold docker` |
| `Dockerfile.vitepressdev` | Scaffolded file | `ce init --scaffold docker` |
| `Dockerfile.vitepressprod` | Scaffolded file | `ce init --scaffold docker` |
| `app-entrypoint.sh` | Scaffolded file | `ce init --scaffold docker` |
| `setup-dns.sh` | Scaffolded file | `ce init --scaffold docker` |
| Caddy reverse-proxy container | Auto-emitted contract | `profile.proxy: "caddy"` (v1.24.4) |
| Caddyfile | Auto-emitted config | `profile.proxy: "caddy"` |
| nginx config | Auto-emitted config | `profile.proxy: "nginx"` (default) |
| docker-compose.yml | Auto-emitted | Any contract with `target` |

Two emission patterns, intentionally:
- **Scaffolded files** — written once at `ce init`, then user-owned.
  They become part of the project and the user customizes them.
- **Auto-emitted contracts/configs** — regenerated every `env:build`,
  user never edits them directly. Configuration knobs come from ce.json
  or contract fields, not from editing the output.

## Where this goes

Candidates for canonical templates as the project grows:

| Service | Form | Trigger (proposed) |
|---------|------|--------------------|
| Postgres | Auto-emitted contract | `profile.persistence.postgres: true` or `ce.json` shortcut |
| Redis | Auto-emitted contract | `profile.persistence.redis: true` |
| MinIO (S3 local) | Auto-emitted contract | `profile.persistence.s3: true` |
| Mailpit / Mailhog | Auto-emitted contract | `profile.dev.mail: true` |
| Process Compose (TUI orchestrator) | Generated `process-compose.yml` | `profile.runtime: "process-compose"` |
| nginx production setup | Multi-file scaffold | `ce init --scaffold nginx-prod` |
| Worker app Dockerfile | Scaffold | `ce init --scaffold worker` (Bun/Node worker, no Next) |
| Hardhat / Foundry contracts app | Scaffold | `ce init --scaffold hardhat` |

## Principles

These guide what should ship as a canonical template:

1. **Most projects need it.** If only 1 in 10 projects wants it, leave
   it as documentation, not scaffolded code. Canonical = "almost
   everyone running this stack benefits."
2. **There's a clear default.** Caddy works as a turnkey proxy because
   there's a clear "right way" to run it. Postgres has many right ways
   (versions, extensions, init scripts) — pick a sane default and let
   contracts override.
3. **The customization surface is small and obvious.** ce.json fields
   or contract fields. Not file editing for non-trivial use cases. If
   users always need to fork the file to make it useful, it shouldn't
   be auto-emitted.
4. **Always overridable.** Whether scaffolded or auto-emitted, the
   user can replace it. Auto-emitted: write a contract with the same
   name (Caddy example — user `caddy.contract.json` wins). Scaffolded:
   edit the file, ce won't overwrite on `scaffold:sync`.
5. **No magic dependencies.** Templates should be self-contained or
   declare their dependencies explicitly. Caddy auto-inject works
   because it derives its mount path from the Caddyfile emitter
   (same trigger). No hidden coupling.

## Convention: where templates live

- **App-side Dockerfiles** (Next.js, VitePress, future Bun, etc.):
  `cli/commands/init.ts` `scaffoldDocker()` / `scaffoldVitepress()`.
  One scaffold function per "template kind" the user can pick.
- **Infrastructure auto-emitters** (Caddy, future Postgres, Redis,
  etc.): `src/builder.ts` injects synthetic contracts before the
  build loop. One injection block per service, gated by ce.json field.
- **Output emitters** (Caddyfile, nginx.conf, future process-compose):
  `src/targets/*.ts` files. Each has a `write*()` function called from
  the builder.

## Migration: existing manual contracts

When a project has a hand-written contract for something composable.env
later auto-emits (e.g., user wrote their own Caddy contract before v1.24.4):
- Auto-emitter checks for existing user contract by name. If present,
  skips synthesis. User's version wins.
- We don't try to merge — if you want defaults, delete your contract.

## Out of scope

- A full "service catalog" UI/CLI (`ce add postgres`, etc.). Maybe
  later. For now, each canonical service ships as a ce.json toggle
  with sane defaults.
- Templates for languages/frameworks beyond the JS/TS world. Python
  apps, Go services, etc. would be their own scaffold types and aren't
  on the near-term roadmap.

## Related

- v1.21.0 — `Dockerfile.nextdev` auto-enumerates per-app package.json
  COPY lines from contracts. Sets the pattern of "scaffolds that pick
  up project state."
- v1.24.4 — Caddy auto-emit. First infrastructure auto-emitter.
- `docs/planning/caddy-emitter/` — original Caddy work, lays groundwork.
