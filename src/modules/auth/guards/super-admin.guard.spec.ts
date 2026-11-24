import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SuperAdminGuard } from './super-admin.guard';

const ctx = (user?: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }), getResponse: () => ({}) }) }) as unknown as ExecutionContext;

describe('SuperAdminGuard', () => {
  const OLD = process.env.SUPERADMIN_EMAILS;
  afterEach(() => { process.env.SUPERADMIN_EMAILS = OLD; });

  const make = (email: string | null) => {
    const g = new SuperAdminGuard({ user: { findUnique: async () => (email ? { email } : null) } } as never);
    (g as never as { jwtGuard: { canActivate: () => Promise<boolean> } }).jwtGuard = { canActivate: async () => true };
    return g;
  };

  it('401 sem usuário autenticado', async () => {
    await expect(make('a@x.com').canActivate(ctx(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('403 com env vazia', async () => {
    process.env.SUPERADMIN_EMAILS = '';
    await expect(make('a@x.com').canActivate(ctx({ userId: '1' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('403 para usuário comum', async () => {
    process.env.SUPERADMIN_EMAILS = 'admin@x.com';
    await expect(make('a@x.com').canActivate(ctx({ userId: '1' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('libera super-admin', async () => {
    process.env.SUPERADMIN_EMAILS = 'Admin@x.com';
    await expect(make('admin@x.com').canActivate(ctx({ userId: '1' }))).resolves.toBe(true);
  });
});
