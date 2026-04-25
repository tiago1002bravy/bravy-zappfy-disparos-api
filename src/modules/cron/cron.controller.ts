import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { nextOccurrences, validateCron } from '../schedules/cron.util';

@ApiTags('cron')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@Controller('cron')
export class CronController {
  @Get('preview')
  preview(@Query('expr') expr: string, @Query('tz') tz = 'America/Sao_Paulo', @Query('count') count = '5') {
    if (!expr || !validateCron(expr)) throw new BadRequestException('Invalid cron expression');
    return { occurrences: nextOccurrences(expr, Math.min(Number(count), 20), tz) };
  }
}
