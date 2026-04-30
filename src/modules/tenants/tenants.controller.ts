import { Body, Controller, Get, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUrl } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class UpdateTenantDto {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) failureWebhookUrl?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) defaultParticipants?: string[];
}

@ApiTags('tenant')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('tenant')
export class TenantsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() u: AuthUser) {
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.findUnique({ where: { id: u.tenantId } }),
    );
    if (!t) return null;
    // Tenant nao tem mais conexao WhatsApp padrao — cada usuario configura a sua
    // em /users/me/connection. As colunas defaultInstance* ainda existem no DB
    // (legacy), mas nao sao mais expostas nem usadas.
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      timezone: t.timezone,
      failureWebhookUrl: t.failureWebhookUrl,
      defaultParticipants: t.defaultParticipants,
    };
  }

  @Patch()
  async update(@CurrentUser() u: AuthUser, @Body() dto: UpdateTenantDto) {
    const data: Record<string, unknown> = {};
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.failureWebhookUrl !== undefined) data.failureWebhookUrl = dto.failureWebhookUrl;
    if (dto.defaultParticipants !== undefined) {
      data.defaultParticipants = dto.defaultParticipants
        .flatMap((p) => p.split(/[\s,;]+/))
        .map((p) => p.replace(/\D/g, ''))
        .filter((p) => p.length >= 10 && p.length <= 15);
    }
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.update({ where: { id: u.tenantId }, data }),
    );
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      timezone: t.timezone,
      failureWebhookUrl: t.failureWebhookUrl,
      defaultParticipants: t.defaultParticipants,
    };
  }

  /** Sinaliza pra UI os defaults disponíveis (apenas participantes — instância é por usuário). */
  @Get('defaults')
  async defaults(@CurrentUser() u: AuthUser) {
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.findUnique({ where: { id: u.tenantId } }),
    );
    return {
      defaultParticipants: t?.defaultParticipants ?? [],
    };
  }

  /** Helper interno: pega participantes padrao do tenant (used pra criar grupos). */
  static async resolveDefaults(prisma: PrismaService, tenantId: string) {
    const t = await prisma.withoutTenant((db) => db.tenant.findUnique({ where: { id: tenantId } }));
    if (!t) return null;
    return {
      defaultParticipants: t.defaultParticipants ?? [],
    };
  }
}
