import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { GroupEventsService, type ZappfyGroupsWebhook } from './group-events.service';

/**
 * Webhook público `groups` da Zappfy (Uazapi), registrado em cada instância do pool.
 * Autenticação: instanceName + token do próprio payload conferidos contra as instâncias
 * cadastradas (ver GroupEventsService.authenticate). Sempre 200 pra não gerar retry.
 */
@ApiTags('zappfy-webhook')
@SkipThrottle()
@Controller('zappfy/webhook/groups')
export class GroupEventsController {
  private readonly log = new Logger('GroupEventsWebhook');

  constructor(private svc: GroupEventsService) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: ZappfyGroupsWebhook) {
    try {
      return { ok: true, ...(await this.svc.handle(body)) };
    } catch (e) {
      this.log.error(`falha ao tratar evento de grupo: ${(e as Error).message}`);
      return { ok: true, handled: false, reason: 'error' };
    }
  }
}
