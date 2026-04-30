import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  ManagedJsonRegistry,
  wrapWithMarkers,
  hasMarkerBlock,
  replaceMarkerBlock,
  loadConfig,
  saveConfig,
} from '../../src/index.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new composable.env directory structure')
    .option('--examples', 'Include example files for all parts of the system')
    .option('--env-dir <path>', 'Custom env directory path (default: "env")')
    .option('--scaffold <type>', 'Scaffold a complete project template (docker)')
    .action(async (options) => {
      const cwd = process.cwd();
      const registry = new ManagedJsonRegistry(cwd);

      // Scaffold or load ce.json
      const ceJsonPath = path.join(cwd, 'ce.json');
      if (!fs.existsSync(ceJsonPath)) {
        const initConfig: Record<string, string> = {
          envDir: options.envDir || 'env',
          defaultProfile: 'default',
        };
        saveConfig(cwd, initConfig);
        console.log(chalk.green('  created ce.json'));
      } else if (options.envDir) {
        saveConfig(cwd, { envDir: options.envDir });
        console.log(chalk.green('  updated ce.json envDir'));
      }

      const config = loadConfig(cwd);
      const envDir = config.envDir;

      const dirs = [
        `${envDir}/components`,
        `${envDir}/profiles`,
        `${envDir}/contracts`,
        `${envDir}/execution`,
      ];

      for (const dir of dirs) {
        const fullPath = path.join(cwd, dir);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
          console.log(chalk.green(`  created ${dir}/`));
        }
      }

      // Scaffold .env.secrets.shared (team secrets, encrypted via vault)
      const secretsSharedPath = path.join(cwd, envDir, '.env.secrets.shared');
      if (!fs.existsSync(secretsSharedPath)) {
        fs.writeFileSync(
          secretsSharedPath,
          '# Team secrets — encrypted via vault, safe to commit\n' +
            '# Set secrets with: ce vault set <KEY> <VALUE>\n' +
            '# Values stored as CENV_ENC[...] are encrypted at rest\n'
        );
        console.log(chalk.green(`  created ${envDir}/.env.secrets.shared`));
      }

      // Scaffold .env.secrets.local (personal secret overrides, gitignored)
      const secretsLocalPath = path.join(cwd, envDir, '.env.secrets.local');
      if (!fs.existsSync(secretsLocalPath)) {
        fs.writeFileSync(
          secretsLocalPath,
          '# Personal secret overrides — DO NOT commit (gitignored)\n' +
            '# Override team secrets for local development\n'
        );
        console.log(chalk.green(`  created ${envDir}/.env.secrets.local`));
      }

      // Scaffold .gitignore with markers
      const gitignorePath = path.join(cwd, '.gitignore');
      const gitignoreEntries = [
        `${envDir}/.env.secrets.local`,
        `${envDir}/.env.secrets.shared`,
        `${envDir}/execution/*.cjs`,
        '# Legacy patterns',
        '.ce.*',
      ].join('\n');
      if (fs.existsSync(gitignorePath)) {
        let content = fs.readFileSync(gitignorePath, 'utf8');
        if (hasMarkerBlock(content)) {
          content = replaceMarkerBlock(content, gitignoreEntries);
        } else {
          content += '\n' + wrapWithMarkers(gitignoreEntries);
        }
        fs.writeFileSync(gitignorePath, content);
        console.log(chalk.green('  updated .gitignore'));
      } else {
        fs.writeFileSync(gitignorePath, wrapWithMarkers(gitignoreEntries));
        console.log(chalk.green('  created .gitignore'));
      }

      // Detect turbo.json and add globalDependencies
      const turboPath = path.join(cwd, 'turbo.json');
      if (fs.existsSync(turboPath)) {
        const turbo = JSON.parse(fs.readFileSync(turboPath, 'utf8'));
        const deps: string[] = turbo.globalDependencies || [];
        const toAdd = ['env/**'];
        let changed = false;

        for (const entry of toAdd) {
          if (!deps.includes(entry)) {
            deps.push(entry);
            changed = true;
          }
        }

        if (changed) {
          turbo.globalDependencies = deps;
          fs.writeFileSync(turboPath, JSON.stringify(turbo, null, 2) + '\n');
          registry.register('turbo.json', 'globalDependencies', toAdd);
          console.log(chalk.green('  updated turbo.json globalDependencies'));
        }
      }

      // Scaffold example files when --examples is passed
      if (options.examples) {
        scaffoldExamples(cwd, envDir, secretsSharedPath, secretsLocalPath);
      }

      // Scaffold a complete project template
      if (options.scaffold === 'docker') {
        scaffoldDocker(cwd, envDir);
        saveConfig(cwd, { scaffold: 'docker' });
      } else if (options.scaffold === 'vitepress') {
        scaffoldVitepress(cwd, envDir);
        saveConfig(cwd, { scaffold: 'vitepress' });
      } else if (options.scaffold && !['docker', 'vitepress'].includes(options.scaffold)) {
        console.log(chalk.yellow(`  Unknown scaffold type: ${options.scaffold}. Available: docker, vitepress`));
      }

      console.log('');
      console.log(chalk.blue('Next steps:'));
      if (options.scaffold === 'docker') {
        console.log(`  1. Add your Next.js apps to ${envDir}/contracts/ as docker-compose targets`);
        console.log(`  2. Add secrets to ${envDir}/.env.secrets.shared`);
        console.log('  3. Run: pnpm ce env:build');
        console.log('  4. Run: pnpm ce dc:up local');
      } else if (options.scaffold === 'vitepress') {
        console.log('  1. Run: pnpm install');
        console.log('  2. Run: pnpm --filter @project/docs dev');
        console.log('  3. Edit apps/docs/ to customize your documentation');
      } else {
        console.log(`  1. Add component files to ${envDir}/components/  (auto-discovered)`);
        console.log(`  2. Add profiles to ${envDir}/profiles/  (optional overrides)`);
        console.log(`  3. Add contract files to ${envDir}/contracts/  (optional)`);
        console.log('  4. Set up vault for secrets: pnpm ce vault init');
        console.log('  5. Add secrets: pnpm ce vault set <KEY> <VALUE>');
        console.log('  6. Run: pnpm ce env:build --profile <name>');
      }
    });

  program
    .command('scaffold:sync')
    .description('Re-run scaffold to create any missing files (reads scaffold type from ce.json)')
    .action(() => {
      const cwd = process.cwd();
      const config = loadConfig(cwd);

      if (!config.scaffold) {
        console.error(chalk.red('No scaffold type in ce.json.'));
        console.error(chalk.gray('   Run "pnpm ce init --scaffold docker" first.'));
        process.exit(1);
      }

      console.log(chalk.blue(`Syncing scaffold: ${config.scaffold}`));
      if (config.scaffold === 'docker') {
        scaffoldDocker(cwd, config.envDir, true);
      } else if (config.scaffold === 'vitepress') {
        scaffoldVitepress(cwd, config.envDir);
      } else {
        console.error(chalk.red(`Unknown scaffold type: ${config.scaffold}`));
        process.exit(1);
      }
      console.log(chalk.green('Scaffold sync complete.'));
    });
}

function scaffoldDocker(cwd: string, envDir: string, syncOnly: boolean = false): void {
  console.log('');
  console.log(chalk.blue('Scaffolding Docker + Next.js project...'));

  // ── local profile ──
  const localProfilePath = path.join(cwd, envDir, 'profiles', 'local.json');
  if (!fs.existsSync(localProfilePath)) {
    fs.writeFileSync(localProfilePath, JSON.stringify({
      name: 'local',
      description: 'Local development with OrbStack',
    }, null, 2) + '\n');
    console.log(chalk.green(`  created ${envDir}/profiles/local.json`));
  }

  // ── production profile ──
  const prodProfilePath = path.join(cwd, envDir, 'profiles', 'production.json');
  if (!fs.existsSync(prodProfilePath)) {
    fs.writeFileSync(prodProfilePath, JSON.stringify({
      name: 'production',
      description: 'Production deployment',
    }, null, 2) + '\n');
    console.log(chalk.green(`  created ${envDir}/profiles/production.json`));
  }

  // ── networking component ──
  const networkingPath = path.join(cwd, envDir, 'components', 'networking.env');
  if (!fs.existsSync(networkingPath)) {
    fs.writeFileSync(networkingPath,
      '; networking.env — DNS and routing per environment\n' +
      '; OrbStack provides automatic .orb.local DNS for Docker containers\n' +
      ';\n' +
      '; Service names in docker-compose become hostnames:\n' +
      ';   myapp-local → myapp-local.orb.local (from host)\n' +
      ';   myapp-local → myapp-local (container-to-container)\n\n' +
      '[default]\n' +
      'DOMAIN=localhost\n' +
      'PROFILE_SUFFIX=-local\n' +
      'BASE_URL=http://localhost\n\n' +
      '[local]\n' +
      'DOMAIN=orb.local\n' +
      'PROFILE_SUFFIX=-local\n' +
      'BASE_URL=http://localhost\n\n' +
      '[production]\n' +
      'DOMAIN=example.com\n' +
      'PROFILE_SUFFIX=\n' +
      'BASE_URL=https://example.com\n'
    );
    console.log(chalk.green(`  created ${envDir}/components/networking.env`));
  }



  // ── docker directory with Dockerfiles ──
  const dockerDir = path.join(cwd, 'docker');
  if (!fs.existsSync(dockerDir)) {
    fs.mkdirSync(dockerDir, { recursive: true });
    console.log(chalk.green('  created docker/'));
  }

  // App entrypoint script — bypasses turbo to pass env vars correctly
  const entrypointPath = path.join(dockerDir, 'app-entrypoint.sh');
  if (!fs.existsSync(entrypointPath)) {
    fs.writeFileSync(entrypointPath,
      '#!/bin/sh\n' +
      '# Entrypoint for app containers — bypasses turbo so Docker env vars\n' +
      '# reach the app process. turbo strips env vars from child processes,\n' +
      '# so we use pnpm --filter directly instead of turbo run.\n' +
      '#\n' +
      '# Usage: docker-compose command field passes the pnpm filter name:\n' +
      '#   command: "@myorg/myapp"\n' +
      '#\n' +
      '# TLS: when CE_TLS_PORT is set (by composable.env tls: true),\n' +
      '# Caddy runs on :443 (HTTPS) and :80 (HTTP redirect).\n' +
      '# The app runs on its normal PORT via plain HTTP internally.\n' +
      '# OrbStack routes https://service.domain to :443, http:// to :80.\n' +
      '\n' +
      'APP_FILTER="$1"\n' +
      '\n' +
      '# Start Caddy TLS proxy if certs are available\n' +
      'if [ -n "$CE_TLS_CERT" ] && [ -f "$CE_TLS_CERT" ] && [ -n "$CE_TLS_PORT" ] && command -v caddy >/dev/null 2>&1; then\n' +
      '  cat > /tmp/Caddyfile <<CADDYEOF\n' +
      '{\n' +
      '  auto_https off\n' +
      '}\n' +
      '\n' +
      ':443 {\n' +
      '  tls ${CE_TLS_CERT} ${CE_TLS_KEY}\n' +
      '  reverse_proxy localhost:${PORT}\n' +
      '}\n' +
      '\n' +
      ':80 {\n' +
      '  redir https://{host}{uri} permanent\n' +
      '}\n' +
      'CADDYEOF\n' +
      '  caddy start --config /tmp/Caddyfile --adapter caddyfile\n' +
      '  echo "Caddy TLS: :443 → :${PORT}, :80 → redirect"\n' +
      'fi\n' +
      '\n' +
      'if [ "$NODE_ENV" = "production" ]; then\n' +
      '  pnpm --filter "$APP_FILTER" build\n' +
      '  exec pnpm --filter "$APP_FILTER" start\n' +
      'else\n' +
      '  exec pnpm --filter "$APP_FILTER" dev\n' +
      'fi\n'
    );
    fs.chmodSync(entrypointPath, 0o755);
    console.log(chalk.green('  created docker/app-entrypoint.sh'));
  }

  // Dockerfile for Next.js local dev (hot reload via volume mounts)
  const dockerfileDevPath = path.join(dockerDir, 'Dockerfile.nextdev');
  if (!fs.existsSync(dockerfileDevPath)) {
    fs.writeFileSync(dockerfileDevPath,
      '# Next.js local development — hot reload via volume mounts\n' +
      'FROM node:20-alpine\n' +
      '\n' +
      'RUN corepack enable && corepack prepare pnpm@latest --activate\n' +
      '\n' +
      '# Caddy for TLS termination (:443 HTTPS, :80 HTTP redirect)\n' +
      'RUN apk add --no-cache caddy\n' +
      '\n' +
      'WORKDIR /app\n' +
      '\n' +
      '# Install dependencies (cached layer)\n' +
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n' +
      'RUN pnpm install --frozen-lockfile\n' +
      '\n' +
      '# Entrypoint bypasses turbo — env vars pass through to the app\n' +
      'COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh\n' +
      '\n' +
      '# Source code comes from volume mounts — not copied\n' +
      '# docker-compose volumes: ["./apps/myapp:/app/apps/myapp"]\n' +
      '\n' +
      '# command: in docker-compose passes the pnpm filter name as $1\n' +
      'ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]\n'
    );
    console.log(chalk.green('  created docker/Dockerfile.nextdev'));
  }

  // Dockerfile for Next.js production (standalone build, no volume mounts)
  const dockerfileProdPath = path.join(dockerDir, 'Dockerfile.nextprod');
  if (!fs.existsSync(dockerfileProdPath)) {
    fs.writeFileSync(dockerfileProdPath,
      '# Next.js production build — standalone output, no source code\n' +
      'FROM node:20-alpine AS base\n' +
      'RUN corepack enable && corepack prepare pnpm@latest --activate\n' +
      '\n' +
      '# ── Install dependencies ──\n' +
      'FROM base AS deps\n' +
      'WORKDIR /app\n' +
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n' +
      'COPY apps/ ./apps/\n' +
      'COPY packages/ ./packages/\n' +
      'RUN pnpm install --frozen-lockfile\n' +
      '\n' +
      '# ── Build ──\n' +
      'FROM deps AS builder\n' +
      'WORKDIR /app\n' +
      '# Build args for any vars needed at build time (non-secret only)\n' +
      'ARG APP_NAME\n' +
      'RUN pnpm --filter ${APP_NAME} build\n' +
      '\n' +
      '# ── Production image ──\n' +
      'FROM node:20-alpine AS runner\n' +
      'WORKDIR /app\n' +
      'ENV NODE_ENV=production\n' +
      '\n' +
      '# Next.js standalone output\n' +
      'COPY --from=builder /app/apps/${APP_NAME}/.next/standalone ./\n' +
      'COPY --from=builder /app/apps/${APP_NAME}/.next/static ./apps/${APP_NAME}/.next/static\n' +
      'COPY --from=builder /app/apps/${APP_NAME}/public ./apps/${APP_NAME}/public\n' +
      '\n' +
      'EXPOSE 3000\n' +
      'CMD ["node", "apps/${APP_NAME}/server.js"]\n'
    );
    console.log(chalk.green('  created docker/Dockerfile.nextprod'));
  }



  // ── Example app contract with Docker target (skip during sync) ──
  const exampleContractPath = path.join(cwd, envDir, 'contracts', 'example-app.contract.json');
  if (!syncOnly && !fs.existsSync(exampleContractPath)) {
    fs.writeFileSync(exampleContractPath, JSON.stringify({
      name: 'example-app',
      location: 'apps/example-app',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'example-app',
        config: {
          build: { context: '.', dockerfile: 'docker/Dockerfile.nextdev' },
          ports: ['3000:3000'],
          volumes: [
            './apps/example-app:/app/apps/example-app',
            './packages:/app/packages',
          ],
          command: '@project/example-app',
          restart: 'unless-stopped',
        },
        profileOverrides: {
          production: {
            build: { context: '.', dockerfile: 'docker/Dockerfile.nextprod' },
            volumes: [],
          },
        },
      },
      vars: {
        PORT: '${example-app.PORT}',
        NODE_ENV: '${example-app.NODE_ENV}',
      },
      defaults: {
        PORT: '3000',
        NODE_ENV: 'development',
      },
      serve: {
        build: 'turbo build --filter=@project/example-app',
      },
    }, null, 2) + '\n');
    console.log(chalk.green(`  created ${envDir}/contracts/example-app.contract.json`));
    console.log(chalk.dim('    → rename and customize for your actual app'));
  }

  // ── VitePress (reuse standalone scaffold) ──
  scaffoldVitepress(cwd, envDir);

  // VitePress Dockerfile for dev (hot reload)
  const dockerfileVitepressDevPath = path.join(dockerDir, 'Dockerfile.vitepressdev');
  if (!fs.existsSync(dockerfileVitepressDevPath)) {
    fs.writeFileSync(dockerfileVitepressDevPath,
      '# VitePress local development — hot reload via volume mounts\n' +
      'FROM node:20-alpine\n' +
      '\n' +
      'RUN corepack enable && corepack prepare pnpm@latest --activate\n' +
      'RUN apk add --no-cache caddy\n' +
      '\n' +
      'WORKDIR /app\n' +
      '\n' +
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n' +
      'RUN pnpm install --frozen-lockfile\n' +
      '\n' +
      '# Entrypoint bypasses turbo — env vars pass through\n' +
      'COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh\n' +
      '\n' +
      '# Source comes from volume mounts\n' +
      'EXPOSE 5173\n' +
      'ENTRYPOINT ["/usr/local/bin/app-entrypoint.sh"]\n'
    );
    console.log(chalk.green('  created docker/Dockerfile.vitepressdev'));
  }

  // VitePress Dockerfile for production (static build + nginx)
  const dockerfileVitepressProdPath = path.join(dockerDir, 'Dockerfile.vitepressprod');
  if (!fs.existsSync(dockerfileVitepressProdPath)) {
    fs.writeFileSync(dockerfileVitepressProdPath,
      '# VitePress production — static build served by nginx\n' +
      'FROM node:20-alpine AS builder\n' +
      '\n' +
      'RUN corepack enable && corepack prepare pnpm@latest --activate\n' +
      '\n' +
      'WORKDIR /app\n' +
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./\n' +
      'COPY apps/docs/ ./apps/docs/\n' +
      'COPY packages/ ./packages/\n' +
      'RUN pnpm install --frozen-lockfile\n' +
      'RUN pnpm --filter @project/docs build\n' +
      '\n' +
      'FROM nginx:alpine\n' +
      'COPY --from=builder /app/apps/docs/.vitepress/dist /usr/share/nginx/html\n' +
      'EXPOSE 80\n'
    );
    console.log(chalk.green('  created docker/Dockerfile.vitepressprod'));
  }

  // Docs contract with docker-compose target
  const docsContractPath = path.join(cwd, envDir, 'contracts', 'docs.contract.json');
  if (!fs.existsSync(docsContractPath)) {
    fs.writeFileSync(docsContractPath, JSON.stringify({
      name: 'docs',
      location: 'apps/docs',
      target: {
        type: 'docker-compose',
        file: 'docker-compose.yml',
        service: 'docs',
        config: {
          build: { context: '.', dockerfile: 'docker/Dockerfile.vitepressdev' },
          ports: ['5173:5173'],
          volumes: [
            './apps/docs:/app/apps/docs',
            './packages:/app/packages',
          ],
          command: '@project/docs',
          restart: 'unless-stopped',
        },
        profileOverrides: {
          production: {
            build: { context: '.', dockerfile: 'docker/Dockerfile.vitepressprod' },
            command: '',
            ports: ['80:80'],
            volumes: [],
          },
        },
      },
      vars: {
        PORT: '${docs.PORT}',
      },
      defaults: {
        PORT: '5173',
      },
    }, null, 2) + '\n');
    console.log(chalk.green(`  created ${envDir}/contracts/docs.contract.json`));
  }

  // ── Add docker-compose.yml to .gitignore ──
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    let content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.includes('docker-compose.yml')) {
      content += '\n# Generated by ce build (contains resolved secrets)\ndocker-compose.yml\ndocker-compose.persistent.yml\n';
      fs.writeFileSync(gitignorePath, content);
      console.log(chalk.green('  updated .gitignore — added docker-compose.yml + docker-compose.persistent.yml'));
    }
  }

  // Update ce.json defaultProfile to local
  saveConfig(cwd, { defaultProfile: 'local' });
  console.log(chalk.green('  updated ce.json defaultProfile → local'));
}

function scaffoldVitepress(cwd: string, envDir: string): void {
  console.log('');
  console.log(chalk.blue('Scaffolding VitePress docs app...'));

  const docsDir = path.join(cwd, 'apps', 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
    console.log(chalk.green('  created apps/docs/'));
  }

  const docsPackageJson = path.join(docsDir, 'package.json');
  if (!fs.existsSync(docsPackageJson)) {
    fs.writeFileSync(docsPackageJson, JSON.stringify({
      name: '@project/docs',
      version: '0.0.0',
      private: true,
      scripts: {
        dev: 'vitepress dev',
        build: 'vitepress build',
        preview: 'vitepress preview',
      },
      devDependencies: {
        vitepress: '^1.5.0',
        vue: '^3.5.0',
      },
    }, null, 2) + '\n');
    console.log(chalk.green('  created apps/docs/package.json'));
  }

  const vitepressDir = path.join(docsDir, '.vitepress');
  if (!fs.existsSync(vitepressDir)) {
    fs.mkdirSync(vitepressDir, { recursive: true });
  }

  const vitepressConfig = path.join(vitepressDir, 'config.ts');
  if (!fs.existsSync(vitepressConfig)) {
    fs.writeFileSync(vitepressConfig,
      "import { defineConfig } from 'vitepress'\n\n" +
      'export default defineConfig({\n' +
      "  title: 'Project Docs',\n" +
      "  description: 'Project documentation',\n" +
      '  themeConfig: {\n' +
      '    nav: [\n' +
      "      { text: 'Home', link: '/' },\n" +
      "      { text: 'Guide', link: '/guide/' },\n" +
      '    ],\n' +
      '    sidebar: [\n' +
      '      {\n' +
      "        text: 'Guide',\n" +
      '        items: [\n' +
      "          { text: 'Getting Started', link: '/guide/' },\n" +
      "          { text: 'Architecture', link: '/guide/architecture' },\n" +
      '        ],\n' +
      '      },\n' +
      '    ],\n' +
      '    socialLinks: [\n' +
      "      { icon: 'github', link: 'https://github.com/' },\n" +
      '    ],\n' +
      '  },\n' +
      '})\n'
    );
    console.log(chalk.green('  created apps/docs/.vitepress/config.ts'));
  }

  const docsIndex = path.join(docsDir, 'index.md');
  if (!fs.existsSync(docsIndex)) {
    fs.writeFileSync(docsIndex,
      '---\n' +
      'layout: home\n' +
      'hero:\n' +
      '  name: Project Docs\n' +
      '  tagline: Documentation for the project\n' +
      '  actions:\n' +
      '    - theme: brand\n' +
      '      text: Get Started\n' +
      '      link: /guide/\n' +
      '---\n'
    );
    console.log(chalk.green('  created apps/docs/index.md'));
  }

  const docsGuideDir = path.join(docsDir, 'guide');
  if (!fs.existsSync(docsGuideDir)) {
    fs.mkdirSync(docsGuideDir, { recursive: true });
  }

  const guideIndex = path.join(docsGuideDir, 'index.md');
  if (!fs.existsSync(guideIndex)) {
    fs.writeFileSync(guideIndex,
      '# Getting Started\n\n' +
      'Welcome to the project documentation.\n\n' +
      '## Prerequisites\n\n' +
      '- Node.js 20+\n' +
      '- pnpm\n' +
      '- [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop\n\n' +
      '## Quick Start\n\n' +
      '```bash\n' +
      'pnpm install\n' +
      'pnpm ce env:build\n' +
      'pnpm ce dc:up local\n' +
      '```\n'
    );
    console.log(chalk.green('  created apps/docs/guide/index.md'));
  }

  const architectureDoc = path.join(docsGuideDir, 'architecture.md');
  if (!fs.existsSync(architectureDoc)) {
    fs.writeFileSync(architectureDoc,
      '# Architecture\n\n' +
      '## Environment Management\n\n' +
      'This project uses [composable.env](https://www.npmjs.com/package/composable.env) to manage environment variables across all services.\n\n' +
      '- **Components** define values (`env/components/*.env`)\n' +
      '- **Contracts** declare what each service needs (`env/contracts/*.contract.json`)\n' +
      '- **Profiles** switch between environments (`env/profiles/*.json`)\n\n' +
      '`pnpm ce env:build` generates `.env` files and `docker-compose.yml` from these sources.\n\n' +
      '## Docker\n\n' +
      'All services run in Docker via `docker compose`. The compose file is fully generated — never hand-edit it.\n\n' +
      '```bash\n' +
      'pnpm ce env:build    # generate all outputs\n' +
      'pnpm ce dc:up local  # start local environment\n' +
      '```\n'
    );
    console.log(chalk.green('  created apps/docs/guide/architecture.md'));
  }
}

function scaffoldExamples(
  cwd: string,
  envDir: string,
  secretsSharedPath: string,
  secretsLocalPath: string
): void {
  console.log('');
  console.log(chalk.blue('Scaffolding examples...'));

  // New format: components without NAMESPACE, using ${secrets.KEY} references
  const exampleComponents: Record<string, string> = {
    'database.env':
      '; database.env — everything about the database, in one place\n\n' +
      '[default]\n' +
      'HOST=localhost\nPORT=5432\nNAME=myapp_dev\n' +
      'USER=${secrets.DB_USER}\nPASSWORD=${secrets.DB_PASSWORD}\n' +
      'URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@localhost:5432/myapp_dev\n\n' +
      '[staging]\n' +
      'HOST=${secrets.DB_HOST}\nNAME=myapp_staging\n' +
      'URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp_staging\n\n' +
      '[production]\n' +
      'HOST=${secrets.DB_HOST}\nNAME=myapp\n' +
      'URL=postgresql://${secrets.DB_USER}:${secrets.DB_PASSWORD}@${secrets.DB_HOST}:5432/myapp\n',
    'redis.env':
      '; redis.env — Redis connection and config\n\n' +
      '[default]\n' +
      'HOST=localhost\nPORT=6379\nURL=redis://localhost:6379\nDB=0\n\n' +
      '[staging]\n' +
      'HOST=${secrets.REDIS_HOST}\nURL=redis://${secrets.REDIS_HOST}:6379\n\n' +
      '[production]\n' +
      'HOST=${secrets.REDIS_HOST}\nURL=redis://${secrets.REDIS_HOST}:6379\nDB=0\n',
  };

  const exampleProfiles: Record<string, object> = {
    'production.json': {
      name: 'Production',
      description: 'Production environment with remote services',
    },
    'staging.json': {
      name: 'Staging',
      description: 'Staging environment — extends production',
      extends: 'production',
    },
  };

  // New format contract with vars
  const exampleContract = {
    name: 'api',
    location: 'apps/api',
    vars: {
      DATABASE_URL: '${database.URL}',
      REDIS_URL: '${redis.URL}',
    },
    defaults: {
      LOG_LEVEL: 'info',
    },
    dev: {
      command: 'pnpm dev',
      label: 'API Server',
    },
  };

  // Scaffold .recipients example
  const recipientsPath = path.join(cwd, envDir, '.recipients');
  if (!fs.existsSync(recipientsPath)) {
    fs.writeFileSync(
      recipientsPath,
      '# composable.env vault recipients\n' +
        '# Each line: public key [optional comment]\n' +
        '#\n' +
        '# Add team members with: ce vault add --github <username>\n' +
        '# Add keys directly with: ce vault add --key "age1..." --comment "name"\n' +
        '#\n' +
        '# Supported key types:\n' +
        '#   age1...           (native age public key)\n' +
        '#   ssh-ed25519 AAAA... (SSH ed25519 public key)\n' +
        '#\n'
    );
    console.log(chalk.green(`  created ${envDir}/.recipients`));
  }

  const exampleSecretsShared =
    '# Team secrets — encrypted via vault, safe to commit\n' +
    '# Set secrets with: ce vault set <KEY> <VALUE>\n\n' +
    '# Database credentials\n' +
    '# DB_USER=CENV_ENC[...]\n' +
    '# DB_PASSWORD=CENV_ENC[...]\n' +
    '# DB_HOST=CENV_ENC[...]\n\n' +
    '# Redis\n' +
    '# REDIS_HOST=CENV_ENC[...]\n';

  const exampleSecretsLocal =
    '# Personal secret overrides — DO NOT commit (gitignored)\n' +
    '# Override team secrets for local development\n\n' +
    'DB_USER=postgres\n' +
    'DB_PASSWORD=postgres\n' +
    'DB_HOST=localhost\n' +
    'REDIS_HOST=localhost\n';

  // Write components
  for (const [filename, content] of Object.entries(exampleComponents)) {
    const filePath = path.join(cwd, envDir, 'components', filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
      console.log(chalk.green(`  created ${envDir}/components/${filename}`));
    }
  }

  // Write profiles
  for (const [filename, data] of Object.entries(exampleProfiles)) {
    const filePath = path.join(cwd, envDir, 'profiles', filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(chalk.green(`  created ${envDir}/profiles/${filename}`));
    }
  }

  // Write contract
  const contractPath = path.join(cwd, envDir, 'contracts/api.contract.json');
  if (!fs.existsSync(contractPath)) {
    fs.writeFileSync(contractPath, JSON.stringify(exampleContract, null, 2) + '\n');
    console.log(chalk.green(`  created ${envDir}/contracts/api.contract.json`));
  }

  // Write secrets files
  fs.writeFileSync(secretsSharedPath, exampleSecretsShared);
  console.log(chalk.green(`  updated ${envDir}/.env.secrets.shared with example values`));
  fs.writeFileSync(secretsLocalPath, exampleSecretsLocal);
  console.log(chalk.green(`  updated ${envDir}/.env.secrets.local with example overrides`));
}
