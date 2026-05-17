# Bug: `env:build <profile>` only emits current profile into `docker-compose.yml`

Flagged 2026-04-21 by InDusk while debugging a downstream numero project. Not yet fixed — this file is a bookmark to pick up later.

## Symptom

Running `pnpm ce env:build staging` followed immediately by `pnpm ce up local` fails with "no service selected." Re-running `pnpm ce env:build local && pnpm ce up local` works. The generated `docker-compose.yml` contains only the last-built profile's services despite its header claiming `# Profiles: local, staging, production`.

## Repro

In any ce project with >1 profile:

1. `pnpm ce env:build local` — save hash of `docker-compose.yml`.
2. `pnpm ce env:build staging` — compose is rewritten; staging-tagged services only.
3. `diff` the two — local-profile services vanished, staging-profile services appeared in their place.

Evidence captured in two reference compose files (one after each build) showed:
- Staging build → `admin-server-stg`, `engine-stg`, etc. tagged `profiles: [staging]`.
- Local build → `admin-server-local`, `engine-local`, etc. tagged `profiles: [local]`, with TLS cert volume mounts and local OTel endpoints.
- No overlap — each build replaces the other's services entirely.

## Root cause

`src/builder.ts:762` — in the loop that converts single-profile entries to the multi-profile format before calling `writeMultiProfileComposeFile`:

```ts
const multiEntries: ComposeMultiProfileEntry[] = entries.map(e => ({
  ...e,
  profileName: currentProfile,   // ← only ever the currently-building profile
  ...
}));
```

`writeMultiProfileComposeFile` expects entries tagged with their actual profile (it uses `profileName` to emit per-profile variants with `profiles: [p]`). But the caller only ever has the current profile's entries — `buildServiceEnvironments` is invoked per-profile from `buildFromProfile`. So the writer receives one profile's worth of entries, stamps them with the current profile's name, and emits a single-profile compose with a multi-profile header.

## Correct invariant

`docker-compose.yml` should be **identical regardless of which profile was just built**. Only the per-profile `.env.{profile}` files should vary. `docker compose --profile <X> up` then selects services by their profile tag at runtime — which is how docker-compose profiles are meant to work.

## Proposed fix (two options)

**Option A — minimal surgery.** Inside `buildServiceEnvironments`, after collecting the current profile's compose entries, also resolve entries for every other profile in `profileSuffixes` and merge them (each tagged with its own profile) before calling `writeMultiProfileComposeFile`. Extract a `computeComposeEntriesForProfile(profileName)` helper. Upside: smallest diff. Downside: each `env:build <p>` re-resolves every profile (correct but slower).

**Option B — cleaner separation.** Move compose generation out of `buildServiceEnvironments` entirely. New `buildComposeFile()` method always iterates all profiles. CLI calls it after `buildFromProfile`. Upside: semantic clarity, compose truly independent of build profile. Downside: bigger refactor.

Either is ~100–200 LOC including test.

## Test shape

Before the fix: write an integration test that sets up a fixture with 2+ profiles, runs `env:build local`, and asserts the resulting `docker-compose.yml` contains services tagged `profiles: [local]` AND `profiles: [staging]`. Currently fails; should pass after either fix.

## Workaround until fixed

Always chain `env:build <p> && up <p>` as a single command in downstream projects. Script shape:

```json
"dev:local": "pnpm ce env:build local && pnpm ce up local",
"dev:staging": "pnpm ce env:build staging && pnpm ce up staging"
```

## Additional observation

The header on the generated compose file (`# Profiles: local, staging, production | Built: …`) is *aspirational* — it lists profile names from `profileSuffixes`, not from the actual content. This makes the bug harder to spot by eyeballing the file. After fix, the header will be accurate.
