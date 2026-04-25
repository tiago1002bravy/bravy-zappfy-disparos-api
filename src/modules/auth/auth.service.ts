import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (existing) throw new ConflictException('Tenant slug already in use');

    const hash = await bcrypt.hash(dto.password, 10);

    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.tenantName,
        slug: dto.tenantSlug,
        users: {
          create: {
            name: dto.name,
            email: dto.email.toLowerCase(),
            password: hash,
            role: 'OWNER',
          },
        },
      },
      include: { users: true },
    });

    const user = tenant.users[0];
    return this.issueTokens(user.id, tenant.id);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const ok = await bcrypt.compare(dto.password, user.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return this.issueTokens(user.id, user.tenantId);
  }

  async refresh(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; tenantId: string }>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
      return this.issueTokens(payload.sub, payload.tenantId);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async issueTokens(userId: string, tenantId: string) {
    const payload = { sub: userId, tenantId };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
    });
    return { accessToken, refreshToken };
  }
}
