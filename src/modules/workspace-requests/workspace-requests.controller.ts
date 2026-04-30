import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class CreateWorkspaceRequestDto {
  @IsString() name!: string;
  @IsString() slug!: string;
  @IsString() requesterName!: string;
  @IsEmail() requesterEmail!: string;
  @MinLength(8) password!: string;
  @IsOptional() @IsString() reason?: string;
}

class RejectDto {
  @IsOptional() @IsString() reason?: string;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function getSuperAdminEmails(): string[] {
  const raw = process.env.SUPERADMIN_EMAILS ?? '';
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

@ApiTags('workspace-requests')
@Controller('workspace-requests')
export class WorkspaceRequestsController {
  constructor(private prisma: PrismaService) {}

  /** Endpoint publico — qualquer um pode submeter um pedido de novo workspace. */
  @Post()
  async create(@Body() dto: CreateWorkspaceRequestDto) {
    const slug = dto.slug.toLowerCase().trim();
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException('Slug inválido (use apenas a-z, 0-9 e hífen)');
    }
    const email = dto.requesterEmail.toLowerCase().trim();
    // Não cria duplicatas pendentes pra mesmo slug ou email
    const existingTenant = await this.prisma.withoutTenant((db) =>
      db.tenant.findUnique({ where: { slug } }),
    );
    if (existingTenant) throw new ConflictException('Este slug já está em uso');
    const existingPending = await this.prisma.withoutTenant((db) =>
      db.workspaceRequest.findFirst({
        where: { OR: [{ slug }, { requesterEmail: email }], status: 'PENDING' },
      }),
    );
    if (existingPending) {
      throw new ConflictException(
        'Já existe uma solicitação pendente com esse slug ou e-mail',
      );
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    await this.prisma.withoutTenant((db) =>
      db.workspaceRequest.create({
        data: {
          name: dto.name,
          slug,
          requesterName: dto.requesterName,
          requesterEmail: email,
          passwordHash,
          reason: dto.reason,
        },
      }),
    );
    return { ok: true, message: 'Solicitação enviada. Aguardando aprovação dos administradores.' };
  }

  // ---- Endpoints administrativos (super-admin via SUPERADMIN_EMAILS) ----

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor)
  async list(@CurrentUser() u: AuthUser) {
    await this.requireSuperAdmin(u);
    return this.prisma.withoutTenant((db) =>
      db.workspaceRequest.findMany({
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          slug: true,
          requesterName: true,
          requesterEmail: true,
          reason: true,
          status: true,
          createdAt: true,
          reviewedAt: true,
          reviewedByEmail: true,
          rejectionReason: true,
        },
      }),
    );
  }

  @Post(':id/approve')
  @ApiBearerAuth()
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor)
  async approve(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const reviewer = await this.requireSuperAdmin(u);
    const req = await this.prisma.withoutTenant((db) =>
      db.workspaceRequest.findUnique({ where: { id } }),
    );
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('Request já foi processado');
    // Cria tenant + usuario OWNER
    const tenant = await this.prisma.withoutTenant((db) =>
      db.tenant.create({
        data: {
          name: req.name,
          slug: req.slug,
          users: {
            create: {
              name: req.requesterName,
              email: req.requesterEmail,
              password: req.passwordHash,
              role: 'OWNER',
            },
          },
        },
      }),
    );
    await this.prisma.withoutTenant((db) =>
      db.workspaceRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedByEmail: reviewer,
          createdTenantId: tenant.id,
        },
      }),
    );
    return { ok: true, tenantId: tenant.id };
  }

  @Post(':id/reject')
  @ApiBearerAuth()
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor)
  async reject(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: RejectDto,
  ) {
    const reviewer = await this.requireSuperAdmin(u);
    const req = await this.prisma.withoutTenant((db) =>
      db.workspaceRequest.findUnique({ where: { id } }),
    );
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'PENDING') throw new BadRequestException('Request já foi processado');
    await this.prisma.withoutTenant((db) =>
      db.workspaceRequest.update({
        where: { id },
        data: {
          status: 'REJECTED',
          reviewedAt: new Date(),
          reviewedByEmail: reviewer,
          rejectionReason: dto.reason ?? null,
        },
      }),
    );
    return { ok: true };
  }

  /** Verifica se o user logado e super-admin (email no SUPERADMIN_EMAILS env). */
  private async requireSuperAdmin(u: AuthUser): Promise<string> {
    if (!u.userId) throw new ForbiddenException('User context missing');
    const me = await this.prisma.user.findUnique({ where: { id: u.userId } });
    if (!me) throw new ForbiddenException('User not found');
    const allowed = getSuperAdminEmails();
    if (allowed.length === 0) {
      // Sem SUPERADMIN_EMAILS configurado, ninguem pode aprovar — falha segura
      throw new ForbiddenException(
        'Aprovação desabilitada. Configure SUPERADMIN_EMAILS no servidor.',
      );
    }
    if (!allowed.includes(me.email.toLowerCase())) {
      throw new ForbiddenException('Apenas super-admins podem revisar solicitações');
    }
    return me.email.toLowerCase();
  }

  static isSuperAdmin(email: string): boolean {
    return getSuperAdminEmails().includes(email.toLowerCase());
  }
}
