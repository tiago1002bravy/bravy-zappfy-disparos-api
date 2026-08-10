import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { MetaWebhookService } from './meta-webhook.service';

/**
 * Webhook público da Meta (Cloud API). Sem guard/tenant de propósito — o
 * lookup é por providerMessageId (wamid, globalmente único). Sempre responde
 * 200 no POST pra não gerar retry storm.
 */
@ApiTags('meta-webhook')
@SkipThrottle()
@Controller('meta/webhook')
export class MetaWebhookController {
  private readonly log = new Logger('MetaWebhook');

  constructor(private svc: MetaWebhookService) {}

  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token === expected) return challenge ?? '';
    throw new ForbiddenException('verify token mismatch');
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<{ ok: boolean }> {
    const secret = process.env.META_APP_SECRET;
    if (secret) {
      if (!this.validSignature(req.rawBody, signature, secret)) {
        this.log.warn('assinatura inválida — payload descartado');
        return { ok: true }; // 200 mesmo assim; só não processa
      }
    }
    await this.svc.process(body as never).catch((err) => {
      this.log.error(`process failed: ${(err as Error).message}`);
    });
    return { ok: true };
  }

  private validSignature(rawBody: Buffer | undefined, signature: string | undefined, secret: string): boolean {
    if (!rawBody || !signature?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const received = signature.slice('sha256='.length);
    if (expected.length !== received.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
    } catch {
      return false;
    }
  }
}
