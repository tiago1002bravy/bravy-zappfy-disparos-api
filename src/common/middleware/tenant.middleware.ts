import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithTenant } from '../tenant-context';

/**
 * Após o passport autenticar, copia req.user.tenantId para o AsyncLocalStorage.
 * É registrado como middleware na rota inteira, mas só efetiva quando há req.user
 * (rotas autenticadas).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const user = req.user as { tenantId?: string; userId?: string; apiKeyId?: string } | undefined;
    if (user?.tenantId) {
      runWithTenant(
        { tenantId: user.tenantId, userId: user.userId, apiKeyId: user.apiKeyId },
        () => next(),
      );
    } else {
      next();
    }
  }
}
