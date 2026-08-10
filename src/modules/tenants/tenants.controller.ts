import { Body, Controller, Get, Patch, Put, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUrl, Matches } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { encryptToken } from '../../common/crypto.util';
import { HotwebinarClient } from '../contacts/hotwebinar.client';

class UpdateTenantDto {
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) failureWebhookUrl?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) defaultParticipants?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) autoJoinPhones?: string[];
}

class SetContactSourceDto {
  // null limpa a fonte (desativa o sync do tenant)
  @IsOptional() @IsString() @Matches(/^postgres(ql)?:\/\//) dbUrl?: string | null;
}

class UpdateGroupDefaultsDto {
  @IsOptional() @IsArray() @IsString({ each: true }) defaultGroupAdmins?: string[];
  @IsOptional() @IsString() defaultGroupDescription?: string | null;
  @IsOptional() @IsString() defaultGroupPictureMediaId?: string | null;
  @IsOptional() @IsBoolean() defaultGroupLocked?: boolean;
  @IsOptional() @IsBoolean() defaultGroupAnnounce?: boolean;
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
      autoJoinPhones: t.autoJoinPhones,
      defaultGroupAdmins: t.defaultGroupAdmins,
      defaultGroupDescription: t.defaultGroupDescription,
      defaultGroupPictureMediaId: t.defaultGroupPictureMediaId,
      defaultGroupLocked: t.defaultGroupLocked,
      defaultGroupAnnounce: t.defaultGroupAnnounce,
      hasContactSource: Boolean(t.contactSourceDbUrlEnc),
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
    if (dto.autoJoinPhones !== undefined) {
      data.autoJoinPhones = dto.autoJoinPhones
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
      autoJoinPhones: t.autoJoinPhones,
    };
  }

  /**
   * Configura a fonte externa de contatos do tenant (Postgres com tabela `leads`
   * no formato hotwebinar). A URL é cifrada em repouso; dbUrl null desativa.
   * Testa a conexão antes de salvar (não bloqueia: salva mesmo com falha e
   * devolve o erro pra UI decidir).
   */
  @Put('contact-source')
  async setContactSource(@CurrentUser() u: AuthUser, @Body() dto: SetContactSourceDto) {
    if (!dto.dbUrl) {
      await this.prisma.withoutTenant((db) =>
        db.tenant.update({ where: { id: u.tenantId }, data: { contactSourceDbUrlEnc: null } }),
      );
      return { hasContactSource: false, connectionOk: null };
    }

    let connectionOk = false;
    let connectionError: string | null = null;
    const client = new HotwebinarClient(dto.dbUrl);
    try {
      await client.countLeads();
      connectionOk = true;
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
    } finally {
      await client.close().catch(() => undefined);
    }

    await this.prisma.withoutTenant((db) =>
      db.tenant.update({
        where: { id: u.tenantId },
        data: { contactSourceDbUrlEnc: encryptToken(dto.dbUrl as string) },
      }),
    );
    return { hasContactSource: true, connectionOk, connectionError };
  }

  /**
   * Configura o banco do inbox (Chat BullQ) pro registro pós-envio dos fluxos
   * (register_template_message). dbUrl null desativa.
   */
  @Put('chat-register')
  async setChatRegister(@CurrentUser() u: AuthUser, @Body() dto: SetContactSourceDto) {
    await this.prisma.withoutTenant((db) =>
      db.tenant.update({
        where: { id: u.tenantId },
        data: { chatRegisterDbUrlEnc: dto.dbUrl ? encryptToken(dto.dbUrl) : null },
      }),
    );
    return { hasChatRegister: Boolean(dto.dbUrl) };
  }

  /** Sinaliza pra UI os defaults disponíveis (apenas participantes — instância é por usuário). */
  @Get('defaults')
  async defaults(@CurrentUser() u: AuthUser) {
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.findUnique({ where: { id: u.tenantId } }),
    );
    return {
      defaultParticipants: t?.defaultParticipants ?? [],
      defaultGroupAdmins: t?.defaultGroupAdmins ?? [],
      defaultGroupDescription: t?.defaultGroupDescription ?? null,
      defaultGroupPictureMediaId: t?.defaultGroupPictureMediaId ?? null,
      defaultGroupLocked: t?.defaultGroupLocked ?? true,
      defaultGroupAnnounce: t?.defaultGroupAnnounce ?? true,
    };
  }

  /** Atualiza os defaults usados em todo grupo criado (front/api/mcp). */
  @Patch('group-defaults')
  async updateGroupDefaults(@CurrentUser() u: AuthUser, @Body() dto: UpdateGroupDefaultsDto) {
    const data: Record<string, unknown> = {};
    if (dto.defaultGroupAdmins !== undefined) {
      data.defaultGroupAdmins = dto.defaultGroupAdmins
        .flatMap((p) => p.split(/[\s,;]+/))
        .map((p) => p.replace(/\D/g, ''))
        .filter((p) => p.length >= 10 && p.length <= 15);
    }
    if (dto.defaultGroupDescription !== undefined)
      data.defaultGroupDescription = dto.defaultGroupDescription;
    if (dto.defaultGroupPictureMediaId !== undefined)
      data.defaultGroupPictureMediaId = dto.defaultGroupPictureMediaId;
    if (dto.defaultGroupLocked !== undefined) data.defaultGroupLocked = dto.defaultGroupLocked;
    if (dto.defaultGroupAnnounce !== undefined)
      data.defaultGroupAnnounce = dto.defaultGroupAnnounce;
    const t = await this.prisma.withoutTenant((db) =>
      db.tenant.update({ where: { id: u.tenantId }, data }),
    );
    return {
      defaultGroupAdmins: t.defaultGroupAdmins,
      defaultGroupDescription: t.defaultGroupDescription,
      defaultGroupPictureMediaId: t.defaultGroupPictureMediaId,
      defaultGroupLocked: t.defaultGroupLocked,
      defaultGroupAnnounce: t.defaultGroupAnnounce,
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
