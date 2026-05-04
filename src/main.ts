import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1', { exclude: ['g/:slug'] });
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const mcpDescription = `
API multi-tenant para agendamento de disparos WhatsApp via Zappfy.

## Autenticação

- **JWT** (UI): \`Authorization: Bearer <accessToken>\` — obtido em \`POST /auth/login\`
- **API Key** (integrações): \`X-Api-Key: zd_xxxxx...\` — gere em \`POST /api-keys\`

## MCP Server

Esta API também tem um **servidor MCP** (Model Context Protocol) pra usar com Claude Desktop, Claude Code, Cursor e outros clientes MCP.

**Repo:** [bravy-zappfy-disparos-mcp](https://github.com/tiago1002bravy/bravy-zappfy-disparos-mcp)

### Configurar no Claude Desktop

\`~/Library/Application Support/Claude/claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "zappfy-disparos": {
      "command": "node",
      "args": ["/caminho/para/bravy-zappfy-disparos-mcp/dist/server.js"],
      "env": {
        "ZAPPFY_API_URL": "https://grupos-api.bravy.com.br/api/v1",
        "ZAPPFY_API_KEY": "zd_..."
      }
    }
  }
}
\`\`\`

### Tools disponíveis no MCP

| Tool | Descrição |
| --- | --- |
| \`list_groups\` | Lista grupos sincronizados (cache local) |
| \`sync_groups\` | Sincroniza grupos do WhatsApp via Zappfy |
| \`list_messages\` | Lista templates de mensagem |
| \`create_message\` | Cria template de mensagem (com mídia opcional) |
| \`upload_media\` | Faz upload de mídia (imagem/vídeo/áudio/PDF) |
| \`list_schedules\` | Lista agendamentos ativos |
| \`schedule_send\` | Cria agendamento (ONCE/DAILY/WEEKLY/CUSTOM_CRON) |
| \`cancel_schedule\` | Cancela agendamento |
| \`schedule_group_update\` | Agenda troca de nome/descrição/foto de grupo |
| \`cron_preview\` | Mostra próximas 5 ocorrências de uma cron expression |

Todas as tools usam a API Key configurada e respeitam o tenant da chave.
`;

  const config = new DocumentBuilder()
    .setTitle('Zappfy Disparos API')
    .setDescription(mcpDescription)
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-Api-Key', in: 'header' }, 'ApiKey')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[API] http://localhost:${port}/api/v1  | docs: /docs`);
}

bootstrap();
