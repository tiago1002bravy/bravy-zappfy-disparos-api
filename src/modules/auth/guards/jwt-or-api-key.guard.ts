import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Aceita JWT (Authorization: Bearer) OU X-Api-Key.
 * Tenta API Key primeiro se header presente, senão JWT.
 */
@Injectable()
export class JwtOrApiKeyGuard extends AuthGuard(['api-key', 'jwt']) {
  canActivate(ctx: ExecutionContext) {
    return super.canActivate(ctx);
  }
}
