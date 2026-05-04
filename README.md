# Zappfy Disparos — API + Worker

API multi-tenant para agendar disparos de WhatsApp via Zappfy.

## Stack

- NestJS + Prisma + PostgreSQL
- BullMQ + Redis (worker)
- MinIO (storage S3-compat)
- JWT + API Keys
- Token Zappfy criptografado em rest (AES-256-GCM)

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

Todos sob `/api/v1/` (exceto `/g/:slug` que é público sem prefixo). Autenticação por JWT (`Authorization: Bearer`) ou API Key (`x-api-key`).

Lista interativa: `https://grupos-api.bravy.com.br/docs` (Swagger UI). OpenAPI JSON em `/docs-json`.

### Auth & tenant

- `POST /auth/register` — cria tenant + owner
- `POST /auth/login`, `POST /auth/refresh`
- `GET/PATCH /tenant` — info do tenant
- `GET /tenant/defaults` — todos os defaults (participantes, admins, descrição, foto, locked, announce)
- `PATCH /tenant/group-defaults` — atualiza defaults aplicados em todo grupo criado
- `GET/POST/DELETE /api-keys`

### Conexão WhatsApp por usuário

- `GET/PATCH /users/me/connection` — instanceName + instanceToken pessoal

### Grupos

- `POST /groups/sync` — sincroniza grupos do WhatsApp pra cache local
- `GET /groups`, `GET /groups/:id`
- `POST /groups` — cria 1 grupo (aplica defaults do tenant automaticamente)
- `POST /groups/bulk-create` — cria N grupos numerados (template `{N}`), opcionalmente cria lista de grupos e/ou shortlink no mesmo passo
- `POST /groups/bulk-apply` — aplica config (descrição/foto/permissões/admins) em N grupos com delays anti-ban
- `PATCH /groups/:id` — nome/descrição/foto via mediaId
- `POST /groups/:id/picture` — foto via `mediaId` | `dataUri` | `imageUrl`
- `POST /groups/:id/permissions` — `locked` (só adm edita) e/ou `announce` (só adm envia)
- `POST /groups/:id/participants` — adicionar (com promote opcional)
- `POST /groups/:id/participants/{promote,demote,remove}`

### Listas de grupos (segmentação)

- `GET/POST/PATCH/DELETE /group-lists`
- `POST /group-lists/:id/groups` — adicionar grupos
- `DELETE /group-lists/:id/groups/:groupId` — remover

### Shortlinks (multi-grupo + rotação + auto-create)

- `GET/POST/PATCH/DELETE /shortlinks`
- `POST /shortlinks/:id/items` — adicionar grupos ao pool
- `DELETE /shortlinks/:id/items/:itemId`
- `PATCH /shortlinks/:id/items/:itemId` — order/status (ACTIVE/FULL/INVALID/DISABLED)
- `POST /shortlinks/:id/items/reorder`
- `POST /shortlinks/:id/items/:itemId/refresh` — refresh do invite via Zappfy
- `GET /shortlinks/:id/stats`
- **`GET /g/:slug`** (público, sem prefixo `/api/v1`) — redirect 302 pro grupo atual

### Mídias

- `POST /media`, `GET /media`, `GET /media/:id`, `DELETE /media/:id`

### Mensagens (texto / mídia / **enquete**)

- `GET/POST/PATCH/DELETE /messages`
- `POST /messages/preview` — preview com spintax + variáveis (`{{group_name}}`, `{{group_remote_id}}`, etc.)
- `POST /messages/:id/send-now` — dispara imediatamente (cria schedule ONCE)
- **Enquete:** passe `pollChoices: string[]` (≥2) e `pollSelectableCount: number` no body do create/patch. Worker chama `zappfy.sendPoll` automaticamente quando `pollChoices.length > 0`.

### Schedules

- `GET/POST/PATCH/DELETE /schedules`
- `GET /schedules/:id/executions`
- `POST /schedules/:id/{pause,resume,cancel}`

### Group updates (renomear/atualizar grupos agendado)

- `GET/POST/PATCH/DELETE /group-update-schedules`

### Outros

- `GET /executions` — histórico global
- `GET /cron/preview?expr=` — preview de cron
- `GET /calendar/events?from=&to=`

## Deploy (Coolify)

3 serviços apontando para o mesmo repo:
1. **api** — Dockerfile.api, porta 3000
2. **worker** — Dockerfile.worker, sem porta exposta
3. Postgres, Redis e MinIO managed pelo Coolify

Antes do primeiro deploy: rodar `pnpm prisma migrate deploy` com `DATABASE_URL` apontando pro banco gerenciado.
