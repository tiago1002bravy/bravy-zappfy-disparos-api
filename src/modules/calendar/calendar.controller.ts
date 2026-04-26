import { BadRequestException, Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { CalendarService, CalendarKind } from './calendar.service';

@ApiTags('calendar')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('calendar')
export class CalendarController {
  constructor(private svc: CalendarService) {}

  @Get('events')
  async events(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('kind') kind: CalendarKind = 'all',
  ) {
    if (!from || !to) throw new BadRequestException('from and to required (ISO date)');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('invalid from/to');
    }
    if (fromDate >= toDate) throw new BadRequestException('from must be before to');
    if (!['all', 'message', 'group-update'].includes(kind)) {
      throw new BadRequestException('invalid kind');
    }
    return this.svc.events(fromDate, toDate, kind);
  }
}
