import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ExecStatus } from '@prisma/client';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('executions')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('executions')
export class ExecutionsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  list(
    @Query('scheduleId') scheduleId?: string,
    @Query('status') status?: ExecStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit = '100',
  ) {
    return this.prisma.execution.findMany({
      where: {
        scheduleId: scheduleId || undefined,
        status: status || undefined,
        ranAt: from || to ? { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } : undefined,
      },
      orderBy: { ranAt: 'desc' },
      take: Math.min(Number(limit), 500),
    });
  }
}
