import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithTenant } from '../tenant-context';

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { tenantId?: string; userId?: string; apiKeyId?: string } | undefined;
    if (!user?.tenantId) return next.handle();
    return new Observable((subscriber) => {
      runWithTenant(
        { tenantId: user.tenantId!, userId: user.userId, apiKeyId: user.apiKeyId },
        () => {
          next.handle().subscribe({
            next: (v) => subscriber.next(v),
            error: (e) => subscriber.error(e),
            complete: () => subscriber.complete(),
          });
        },
      );
    });
  }
}
