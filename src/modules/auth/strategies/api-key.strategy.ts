import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import type { Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { sha256 } from '../../../common/crypto.util';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  private prisma = new PrismaClient();

  async validate(req: Request) {
    const raw = req.header('x-api-key');
    if (!raw) return null; // deixa AuthGuard tentar próxima estratégia
    const hash = sha256(raw);
    const key = await this.prisma.apiKey.findUnique({ where: { hash } });
    if (!key || key.revokedAt) return null;
    await this.prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    });
    return { tenantId: key.tenantId, apiKeyId: key.id, scopes: key.scopes };
  }
}
