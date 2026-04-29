import { Body, Controller, Get, Patch, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { encryptToken, decryptToken } from '../../common/crypto.util';

class UpdateConnectionDto {
  @IsOptional() @IsString() instanceName?: string | null;
  @IsOptional() @IsString() instanceToken?: string | null;
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const user = await this.prisma.user.findUnique({ where: { id: u.userId } });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      instanceName: user.instanceName,
      hasInstanceToken: !!user.instanceTokenEnc,
    };
  }

  @Patch('me/connection')
  async updateConnection(@CurrentUser() u: AuthUser, @Body() dto: UpdateConnectionDto) {
    const data: Record<string, unknown> = {};
    if (dto.instanceName !== undefined) data.instanceName = dto.instanceName || null;
    if (dto.instanceToken !== undefined) {
      data.instanceTokenEnc = dto.instanceToken ? encryptToken(dto.instanceToken) : null;
    }
    const user = await this.prisma.user.update({ where: { id: u.userId }, data });
    return {
      instanceName: user.instanceName,
      hasInstanceToken: !!user.instanceTokenEnc,
    };
  }

  /**
   * Helper interno: resolve a conexão do usuário, com fallback pro tenant.
   * Retorna instance name + token decifrado, ou null se nem o user nem o tenant tem.
   */
  static async resolveConnection(
    prisma: PrismaService,
    userId: string | undefined,
    tenantId: string,
  ): Promise<{ instanceName: string; instanceToken: string } | null> {
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user?.instanceName && user.instanceTokenEnc) {
        return {
          instanceName: user.instanceName,
          instanceToken: decryptToken(user.instanceTokenEnc),
        };
      }
    }
    const t = await prisma.withoutTenant((db) =>
      db.tenant.findUnique({ where: { id: tenantId } }),
    );
    if (t?.defaultInstanceName && t.defaultInstanceTokenEnc) {
      return {
        instanceName: t.defaultInstanceName,
        instanceToken: decryptToken(t.defaultInstanceTokenEnc),
      };
    }
    return null;
  }
}
