import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  userId?: string;
  tenantId: string;
  apiKeyId?: string;
  scopes?: string[];
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
