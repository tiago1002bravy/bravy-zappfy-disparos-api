import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { generateApiKey } from '../../common/crypto.util';
import { requireTenantId } from '../../common/tenant-context';

@Injectable()
export class ApiKeysService {
  constructor(private prisma: PrismaService) {}

  async create(name: string, scopes: string[] = [], userId: string | null = null) {
    const tenantId = requireTenantId();
    if (userId) {
      // Valida que o user pertence ao mesmo tenant pra evitar vazar key cross-tenant
      const u = await this.prisma.user.findFirst({
        where: { id: userId, tenantId },
        select: { id: true },
      });
      if (!u) throw new NotFoundException('Usuário não encontrado no tenant');
    }
    const { plain, prefix, hash } = generateApiKey();
    const key = await this.prisma.apiKey.create({
      data: { tenantId, userId, name, prefix, hash, scopes },
    });
    return { ...key, hash: undefined, plain };
  }

  list() {
    return this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        userId: true,
        user: { select: { id: true, email: true, name: true } },
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });
  }

  async revoke(id: string) {
    const k = await this.prisma.apiKey.findFirst({ where: { id } });
    if (!k) throw new NotFoundException('API Key not found');
    return this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }
}
