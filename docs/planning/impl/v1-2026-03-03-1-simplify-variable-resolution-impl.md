---
title: "Impl: Simplify Variable Resolution — 3 Concepts, 1 Hop Each"
date: 2026-03-03
status: draft
adr: v1-2026-03-03-1-simplify-variable-resolution-adr.md
---

# Impl: Simplify Variable Resolution — 3 Concepts, 1 Hop Each

## Goal

Replace the NAMESPACE auto-prefix system and `required`/`optional`/`secret` contract split with a three-concept model (secrets, components, contracts) where contracts use `${component.KEY}` references, secrets live in `.env.secrets.shared` / `.env.secrets.local`, and generated output files use `.env.{profile}` naming.

## Scope

### In Scope
- New `vars` contract field with `${component.KEY}` and `${secrets.KEY}` syntax
- Secrets files: `.env.secrets.shared` (committed, encrypted) and `.env.secrets.local` (gitignored)
- Remove NAMESPACE auto-prefixing from builder
- Output `.env.{profile}` instead of `.ce.{profile}`
- Component-scoped variable resolution (no global flat pool)
- Backwards compatibility: detect and support old contract format during transition
- Update `ce init`, `ce build`, `ce run`, `ce uninstall`, `ce start` for new file patterns
- Update examples and documentation
- `ce migrate` command for automated migration

### Out of Scope
- Profile inheritance changes (stays the same)
- Vault encryption mechanism changes (stays the same, just different file paths)
- Execution/Zellij addon changes (stays the same, just new output filenames)
- Removing `.contract.ts` support (stays alongside JSON)

## Checklist

### Phase 1: Secrets Layer

- [ ] Add `.env.secrets.shared` loading in `src/builder.ts` `loadSharedFiles()`
  - Load after components, before `.env.local`
  - Decrypt `CENV_ENC[]` values (vault integration stays the same)
  - Secrets are available in pool as `secrets.KEY` namespace
- [ ] Add `.env.secrets.local` loading (gitignored, personal overrides for secrets)
  - Loads after `.env.secrets.shared`, overrides matching keys
- [ ] Keep `.env.shared` / `.env.local` loading as fallback for backwards compat
  - Deprecation warning when `.env.shared` contains values that look like secrets
- [ ] Update `ce init` to scaffold `.env.secrets.shared` and `.env.secrets.local`
- [ ] Update gitignore entries: add `env/.env.secrets.local`
- [ ] Update `ce vault set` to write to `.env.secrets.shared` instead of `.env.shared`

### Phase 2: Contract Format — `vars` Field

- [ ] Add `vars` field to `ServiceContract` interface in `src/contracts.ts`
  ```typescript
  vars?: Record<string, string>;  // ${component.KEY} mappings
  ```
- [ ] Add format detection in `ContractManager`: if contract has `vars`, use new resolution; if `required`, use legacy
- [ ] Implement `${component.KEY}` resolution in new `resolveComponentRef()` method
  - Parse `component.KEY` from `${...}` syntax
  - Look up component name → load that component's values for active profile section
  - Resolve `${secrets.KEY}` from the secrets pool
  - Support templates: `postgresql://${database.USER}:${database.PASSWORD}@${database.HOST}:5432/${database.NAME}`
- [ ] Implement validation for `vars` contracts:
  - Every `${component.KEY}` must resolve to a value
  - Keys in `vars` but NOT in `defaults` are required (fail if missing)
  - Keys in both `vars` and `defaults` are optional (use default if missing)
- [ ] Keep old `required`/`optional`/`secret` resolution working unchanged (legacy path)
- [ ] Log deprecation warning when loading a contract with `required` field

### Phase 3: Component Resolution — Drop NAMESPACE

- [ ] Modify `loadComponentConfig()` in `src/builder.ts`:
  - When loading for new-format contracts: skip NAMESPACE prefixing, store as `{componentName}.{KEY}`
  - When loading for legacy contracts: keep NAMESPACE prefixing (backwards compat)
- [ ] New method `loadComponentPool()` that returns `Map<string, Record<string, string>>` keyed by component name instead of flat pool
  - Each component's values stored under its filename (without `.env`)
  - `secrets` is a reserved component name (loaded from secrets files)
- [ ] Multi-pass `${...}` resolution across component boundaries:
  - Pass 1: resolve `${secrets.KEY}` in all components
  - Pass 2: resolve `${component.KEY}` cross-references (component A referencing component B)
  - Max passes with cycle detection (reuse existing pattern from `resolveVariables()`)

### Phase 4: Output Naming — `.env.{profile}`

- [ ] Change output filename in `buildServiceEnvironments()`: `${contract.location}/.env.${this.envName}` instead of `.ce.${this.envName}`
- [ ] Change output filename in `generateServiceEnvFile()`: `.env.${serviceName}` default
- [ ] Update `ce run` to look for `.env.{profile}` (with `.ce.{profile}` fallback for transition)
- [ ] Update `ce start` to reference `.env.{profile}` paths
- [ ] Update `ce init` gitignore entries: pattern for generated `.env.*` files
  - Need careful pattern — can't just gitignore all `.env.*` (would catch `.env.local`, `.env.secrets.*`)
  - Strategy: `ce build` writes a `.ce-generated` manifest listing generated files, gitignore references the manifest or uses a comment-based approach
  - Alternative: gitignore pattern like `**/.env.default`, `**/.env.production`, `**/.env.staging` based on known profiles
- [ ] Update `ce uninstall` `findCeFiles()` to find `.env.{profile}` files
  - Use `.ce-managed.json` registry or the generated-file comment header to identify ce-generated files
  - Check for `# Generated by composable.env` header to distinguish from manually-created .env files

### Phase 5: `ce migrate` Command

- [ ] Create `cli/commands/migrate.ts`
- [ ] Detect old-format contracts (have `required` field, no `vars` field)
- [ ] Transform contract: merge `required`, `optional`, `secret` into `vars`
  - `"REDIS_URL": "REDIS_JOB_QUEUE_URL"` → `"REDIS_URL": "${redis.JOB_QUEUE_URL}"`
  - Requires reverse-mapping NAMESPACE prefix → component name + key
  - Read all components to build the reverse map
- [ ] Transform components: remove `NAMESPACE=` directive
- [ ] Migrate `.env.shared` secrets → `.env.secrets.shared`
  - Move lines containing `CENV_ENC[` to `.env.secrets.shared`
  - Keep non-secret lines in components or flag for manual placement
- [ ] Dry-run mode: show what would change without writing
- [ ] Validate: `ce build` with migrated files produces identical output
- [ ] Register in `cli/index.ts`

### Phase 6: Update Init & Scaffolding

- [ ] Update `ce init` to scaffold new file structure:
  - `env/.env.secrets.shared` (with vault header comment)
  - `env/.env.secrets.local` (with gitignore reminder comment)
  - Keep `env/.env.local` for non-secret personal overrides
  - Remove `env/.env.shared` from scaffold (replaced by secrets files + components)
- [ ] Update `ce init --examples` to use new contract format with `vars`
- [ ] Update example contract: `vars` with `${component.KEY}` syntax
- [ ] Update example components: no NAMESPACE directive
- [ ] Update gitignore scaffold entries

### Phase 7: Documentation & Examples

- [ ] Rewrite `examples/fullstack/` to use new format:
  - Components without NAMESPACE
  - Contracts with `vars` field
  - `.env.secrets.shared` / `.env.secrets.local` files
- [ ] Update README.md:
  - New resolution chain diagram
  - Contract format examples
  - Secrets file documentation
  - Directory structure
  - Migration guide section
- [ ] Update AGENTS.md with new architecture description
- [ ] Update `.claude/skills/` skill docs
- [ ] Update `ce --help` descriptions where affected

### Verification

- [ ] `npm run build` compiles clean
- [ ] `npm test` passes (no regressions)
- [ ] New-format contracts resolve `${component.KEY}` correctly
- [ ] New-format contracts resolve `${secrets.KEY}` correctly
- [ ] Cross-component references work (`${database.URL}` inside a component that isn't database.env)
- [ ] Legacy contracts (`required`/`optional`/`secret`) still work unchanged
- [ ] `ce migrate` transforms example contracts correctly
- [ ] `ce migrate --dry-run` shows changes without modifying files
- [ ] Generated `.env.{profile}` files contain identical content to old `.ce.{profile}` files
- [ ] `ce run` finds `.env.{profile}` files and falls back to `.ce.{profile}`
- [ ] `ce start --dry-run` works with new output naming
- [ ] `ce init --examples` scaffolds new-format examples
- [ ] `ce uninstall --dry-run` identifies generated `.env.*` files correctly (doesn't flag manual ones)
- [ ] Vault encrypt/decrypt works with `.env.secrets.shared`
- [ ] `.env.secrets.local` overrides `.env.secrets.shared` values

## Files Affected

| File | Change |
|------|--------|
| `src/contracts.ts` | Add `vars` field to `ServiceContract`, format detection, `${component.KEY}` resolution |
| `src/builder.ts` | Component-scoped loading, secrets layer, `.env.{profile}` output, drop NAMESPACE |
| `src/types.ts` | Update Zod schemas if contract validation uses them |
| `cli/commands/build.ts` | Output path changes (`.env.{profile}`) |
| `cli/commands/run.ts` | Look for `.env.{profile}` with `.ce.{profile}` fallback |
| `cli/commands/start.ts` | Reference `.env.{profile}` paths |
| `cli/commands/init.ts` | Scaffold `.env.secrets.shared`, `.env.secrets.local`, new gitignore patterns |
| `cli/commands/uninstall.ts` | Find `.env.{profile}` generated files, clean up secrets files |
| `cli/commands/migrate.ts` | New — automated migration command |
| `cli/commands/vault.ts` | Write to `.env.secrets.shared` instead of `.env.shared` |
| `cli/index.ts` | Register migrate command |
| `examples/fullstack/` | Rewrite all contracts, components, and add secrets files |
| `README.md` | Full documentation rewrite for new model |
| `AGENTS.md` | Architecture description update |

## Dependencies

- Phases 1-3 are the core engine changes and must be done together (they're interdependent)
- Phase 4 (output naming) can be done independently but should follow 1-3
- Phase 5 (migrate) depends on phases 1-4 being complete (needs to validate output matches)
- Phases 6-7 (scaffolding, docs) can be done last
- Backwards compatibility for old format must be maintained through all phases

## Notes

- **Backwards compat is mandatory during transition.** The builder must detect contract format (has `vars` → new path, has `required` → legacy path) and handle both. This means the old NAMESPACE code stays but is only activated for legacy contracts.
- **The `secrets` namespace is reserved.** No component file can be named `secrets.env` — it would collide with the `${secrets.KEY}` resolution. Validate this during component loading.
- **Gitignore for `.env.{profile}` is the trickiest part.** Unlike `.ce.*` which was a unique prefix, `.env.*` is common. Options:
  1. Write a `.ce-generated` manifest during build, gitignore entries reference it
  2. Use the `# Generated by composable.env` header and teach uninstall to check for it
  3. Add generated file paths to `.gitignore` dynamically via marker blocks during build
  4. Document that users should add their profile-named patterns manually
  - Option 3 (marker blocks during build) is most consistent with existing patterns.
- **Profile sections in secrets files**: The ADR mentions profile-specific secrets could use sections. For v1 of this impl, keep secrets flat (one value per key, local overrides shared). Profile-specific secrets can be a v2 enhancement if needed.
- **Component cross-references**: A component like `redis.env` might reference `${database.HOST}`. This is resolved in Pass 2 of the multi-pass resolution. Circular references between components should be detected and error clearly.
- **Open question**: Should `.env.local` override component values using component-qualified names (`database.HOST=custom`) or flat names (`DATABASE_HOST=custom` for legacy compat)? Start with flat names for `.env.local` (it's the escape hatch, should be simple) and component-qualified names for contracts.
