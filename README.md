# Zappfy Disparos — API + Worker

API multi-tenant para agendar disparos de WhatsApp via Uazapi.

## Stack

- NestJS + Prisma + PostgreSQL
- BullMQ + Redis (worker)
- MinIO (storage S3-compat)
- JWT + API Keys
- Token Uazapi criptografado em rest (AES-256-GCM)

## Subir em dev (sem Docker)

Pré-requisitos: Postgres 16, Redis, MinIO rodando localmente.

```bash
pnpm install
cp .env.example .env
# ajusta DATABASE_URL e gera INSTANCE_TOKEN_ENC_KEY:
openssl rand -hex 32

pnpm prisma migrate dev
pnpm start:dev          # API em :3000
# em outro terminal:
pnpm start:worker:dev   # worker
```

Swagger: http://localhost:3000/docs

## Subir em dev (com Docker)

```bash
docker compose up -d
pnpm install
pnpm prisma migrate dev
pnpm start:dev
pnpm start:worker:dev
```

## Variáveis de ambiente

Veja `.env.example`. Atenção:

- `INSTANCE_TOKEN_ENC_KEY`: 32 bytes hex (64 caracteres). Gere com `openssl rand -hex 32`.
- `JWT_SECRET` / `JWT_REFRESH_SECRET`: rotacionar em prod.

## Endpoints

Todos sob `/api/v1/`. Autenticação por JWT (`Authorization: Bearer`) ou API Key (`X-Api-Key`).

- `POST /auth/register` — cria tenant + owner
- `POST /auth/login`
- `POST /auth/refresh`
- `GET/PATCH /tenant`
- `GET/POST/DELETE /api-keys`
- `POST /groups/sync` (body: instanceName, instanceToken)
- `GET /groups`, `PATCH /groups/:id`
- `POST /media`, `GET /media`, `DELETE /media/:id`
- `GET/POST/PATCH/DELETE /messages`
- `GET/POST/PATCH/DELETE /schedules`, `GET /schedules/:id/executions`
- `GET/POST/PATCH/DELETE /group-update-schedules`
- `GET /executions`
- `GET /cron/preview?expr=`

## Deploy (Coolify)

3 serviços apontando para o mesmo repo:
1. **api** — Dockerfile.api, porta 3000
2. **worker** — Dockerfile.worker, sem porta exposta
3. Postgres, Redis e MinIO managed pelo Coolify

Antes do primeiro deploy: rodar `pnpm prisma migrate deploy` com `DATABASE_URL` apontando pro banco gerenciado.
