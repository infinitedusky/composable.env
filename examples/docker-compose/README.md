# Docker Compose Example

A project where the **entire docker-compose.yml is generated** by `ce build`.
No hand-authored compose file — contracts define both the service topology
(image, ports, volumes) and the resolved environment variables.

## The setup

One Docker image (`app`) runs the API, Thirdweb Engine, and Postgres together
via PM2. A separate Redis container sits alongside it.

**6 contracts, 2 Docker services:**

| Contract | Targets | What it does |
|----------|---------|-------------|
| `app-container` | `app` | Defines the container: build context, ports, volumes, depends_on |
| `api` | `app` + `apps/api` | Adds API env vars to the container. Also writes `.env` for local dev |
| `engine` | `app` | Adds Engine env vars to the container |
| `postgres` | `app` | Adds Postgres env vars to the container |
| `worker` | `app` | Adds worker env vars to the container |
| `redis` | `redis` | Defines the Redis container (image, ports) |

The `app-container` contract defines the Docker service config (build, ports,
volumes). The other contracts just contribute their environment variables to
it. Everything merges into one `app` service in the generated compose file.

## Generated docker-compose.yml

After `ce build --profile docker`:

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "4000:4000"
      - "3005:3005"
    depends_on:
      - redis
    restart: unless-stopped
    volumes:
      - ./data:/app/data
    environment:
      API_PORT: "4000"
      DATABASE_URL: "postgresql://postgres:localdevpassword@postgres:5432/myapp_dev"
      REDIS_URL: "redis://redis:6379"
      JWT_SECRET: "super-secret-jwt-key-change-me"
      LOG_LEVEL: "info"
      CORS_ORIGIN: "http://localhost:3000"
      ENGINE_PORT: "3005"
      ENCRYPTION_PASSWORD: "engine-encryption-password"
      THIRDWEB_API_SECRET_KEY: "tb_sk_example_key_here"
      ADMIN_WALLET_ADDRESS: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18"
      POSTGRES_USER: "postgres"
      POSTGRES_PASSWORD: "localdevpassword"
      POSTGRES_DB: "myapp_dev"
      POSTGRES_HOST: "postgres"
      POSTGRES_PORT: "5432"
      WORKER_CONCURRENCY: "4"
      QUEUE_URL: "redis://redis:6379"
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    restart: unless-stopped
```

## Usage

```bash
# Build for Docker (uses [docker] component sections with internal hostnames)
ce build --profile docker
docker compose up

# Build for local dev (uses [default] sections with localhost)
ce build --profile local
ce start --profile local    # runs API via PM2

# Build for production
ce build --profile production
```

## Key concepts

- **docker-compose.yml is gitignored** — it's a build artifact containing resolved secrets
- **Contracts are the source of truth** — versioned, define both topology and env
- **One container, multiple contracts** — api, engine, postgres, worker all target `app`
- **`config` defines the container** — image, ports, volumes, depends_on
- **`vars` define the environment** — merged additively from all targeting contracts
- **`[docker]` profile** — components use Docker-internal hostnames (`postgres`, `redis`) instead of `localhost`
- **API has both `location` + `target`** — works locally with PM2 and in Docker from the same contract
