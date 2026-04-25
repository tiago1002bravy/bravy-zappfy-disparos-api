import { Body, Controller, Get, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUrl } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { encryptToken, decryptToken } from '../../common/crypto.util';

class UpdateTenantDto {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) failureWebhookUrl?: string | null;
  @IsOptional() @IsString() defaultInstanceName?: string | null;
  @IsOptional() @IsString() defaultInstanceToken?: string | null;
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
    // Não retornamos o token criptografado, mas sinalizamos que existe
    return {
      ...t,
      defaultInstanceTokenEnc: undefined,
      hasDefaultInstanceToken: !!t.defaultInstanceTokenEnc,
    };
  }

  @Patch()
  async update(@CurrentUser() u: AuthUser, @Body() dto: UpdateTenantDto) {
    const data: Record<string, unknown> = {};
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.failureWebhookUrl !== undefined) data.failureWebhookUrl = dto.failureWebhookUrl;
    if (dto.defaultInstanceName !== undefined)
      data.defaultInstanceName = dto.defaultInstanceName || null;
    if (dto.defaultInstanceToken !== undefined) {
      data.defaultInstanceTokenEnc = dto.defaultInstanceToken
        ? encryptToken(dto.defaultInstanceToken)
        : null;
    }
    if (dto.defaultParticipants !== undefined) {
      data.defaultParticipants = dto.defaultParticipants
        .flatMap((p) => p.split(/[\s,;]+/))
        .map((p) => p.replace(/\D/g, ''))
        .filter((p) => p.length >= 10 && p.length <= 15);
    }
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.update({ where: { id: u.tenantId }, data }),
    );
    return { ...t, defaultInstanceTokenEnc: undefined, hasDefaultInstanceToken: !!t.defaultInstanceTokenEnc };
  }

  /** Sinaliza pra UI se existem defaults configurados (sem expor o token). */
  @Get('defaults')
  async defaults(@CurrentUser() u: AuthUser) {
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.findUnique({ where: { id: u.tenantId } }),
    );
    return {
      hasInstance: !!(t?.defaultInstanceName && t?.defaultInstanceTokenEnc),
      instanceName: t?.defaultInstanceName ?? null,
      defaultParticipants: t?.defaultParticipants ?? [],
    };
  }

  /** Helper interno: pega defaults decifrados (não exposto via HTTP, só pra outros services). */
  static async resolveDefaults(prisma: PrismaService, tenantId: string) {
    const t = await prisma.withoutTenant((db) => db.tenant.findUnique({ where: { id: tenantId } }));
    if (!t) return null;
    return {
      defaultInstanceName: t.defaultInstanceName,
      defaultInstanceToken: t.defaultInstanceTokenEnc ? decryptToken(t.defaultInstanceTokenEnc) : null,
      defaultParticipants: t.defaultParticipants ?? [],
    };
  }
}
