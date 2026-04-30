import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { encryptToken, decryptToken } from '../../common/crypto.util';

class UpdateConnectionDto {
  @IsOptional() @IsString() instanceName?: string | null;
  @IsOptional() @IsString() instanceToken?: string | null;
}

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() name!: string;
  @MinLength(8) password!: string;
  @IsOptional() @IsEnum(Role) role?: Role;
}

class UpdateUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
}

const ADMIN_ROLES: Role[] = ['OWNER', 'ADMIN'];

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    if (!u.userId) return null;
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
    if (!u.userId) throw new ForbiddenException('User context missing');
    const data: Record<string, unknown> = {};
    if (dto.instanceName !== undefined) data.instanceName = dto.instanceName || null;
    if (dto.instanceToken !== undefined) {
      data.instanceTokenEnc = dto.instanceToken ? encryptToken(dto.instanceToken) : null;
    }
    if (Object.keys(data).length === 0) {
      // Nada pra atualizar — retorna estado atual em vez de zerar acidentalmente
      const current = await this.prisma.user.findUnique({ where: { id: u.userId } });
      return {
        instanceName: current?.instanceName ?? null,
        hasInstanceToken: !!current?.instanceTokenEnc,
      };
    }
    const user = await this.prisma.user.update({ where: { id: u.userId }, data });
    return {
      instanceName: user.instanceName,
      hasInstanceToken: !!user.instanceTokenEnc,
    };
  }

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        instanceName: true,
        instanceTokenEnc: true,
        createdAt: true,
      },
    });
    return users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      instanceName: user.instanceName,
      hasInstanceToken: !!user.instanceTokenEnc,
      createdAt: user.createdAt,
      isMe: user.id === u.userId,
    }));
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateUserDto) {
    await this.requireAdmin(u);
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) throw new ConflictException('E-mail já cadastrado nesta conta');
    const hash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        tenantId: u.tenantId,
        email,
        password: hash,
        name: dto.name,
        role: dto.role ?? 'OPERATOR',
      },
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      instanceName: user.instanceName,
      hasInstanceToken: !!user.instanceTokenEnc,
      createdAt: user.createdAt,
      isMe: false,
    };
  }

  @Patch(':id')
  async update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    await this.requireAdmin(u);
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'OWNER' && dto.role && dto.role !== 'OWNER') {
      throw new BadRequestException('Não é possível rebaixar o owner');
    }
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.role !== undefined) data.role = dto.role;
    const updated = await this.prisma.user.update({ where: { id }, data });
    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
    };
  }

  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.requireAdmin(u);
    if (id === u.userId) {
      throw new BadRequestException('Você não pode remover sua própria conta');
    }
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    if (target.role === 'OWNER') {
      throw new BadRequestException('Não é possível remover o owner da conta');
    }
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }

  private async requireAdmin(u: AuthUser) {
    if (!u.userId) throw new ForbiddenException('User context missing');
    const me = await this.prisma.user.findUnique({ where: { id: u.userId } });
    if (!me || !ADMIN_ROLES.includes(me.role)) {
      throw new ForbiddenException('Apenas owner ou admin pode gerenciar usuários');
    }
  }

  /**
   * Helper interno: resolve a conexão WhatsApp do usuário.
   * Cada usuário precisa configurar a sua. Sem fallback pro tenant —
   * compartilhar número entre operadores aumenta o risco de ban no WhatsApp.
   */
  static async resolveConnection(
    prisma: PrismaService,
    userId: string | undefined,
  ): Promise<{ instanceName: string; instanceToken: string } | null> {
    if (!userId) return null;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.instanceName || !user.instanceTokenEnc) return null;
    return {
      instanceName: user.instanceName,
      instanceToken: decryptToken(user.instanceTokenEnc),
    };
  }
}
