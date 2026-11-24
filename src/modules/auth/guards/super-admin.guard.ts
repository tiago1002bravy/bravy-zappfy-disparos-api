import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../../../prisma/prisma.service';

/** Lista de e-mails de super-admin da plataforma (mesma env do fluxo de workspace-requests). */
export function getSuperAdminEmails(): string[] {
  return (process.env.SUPERADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

class JwtOnlyGuard extends AuthGuard('jwt') {}

/**
 * Exige JWT válido (sem API Key) de um usuário cujo e-mail está em SUPERADMIN_EMAILS.
 * Sem credencial: 401. Credencial sem permissão (ou env vazia): 403 (falha segura).
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  private readonly jwtGuard = new JwtOnlyGuard();

  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await this.jwtGuard.canActivate(ctx); // lança 401 se não houver JWT válido
    const req = ctx.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.userId;
    if (!userId) throw new UnauthorizedException();
    const allowed = getSuperAdminEmails();
    if (allowed.length === 0) throw new ForbiddenException('Cadastro direto desabilitado');
    const me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!me || !allowed.includes(me.email.toLowerCase())) {
      throw new ForbiddenException('Apenas super-admins podem criar workspaces diretamente');
    }
    return true;
  }
}
