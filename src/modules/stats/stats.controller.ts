import { Controller, Get, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { StatsService } from './stats.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class RangeQueryDto {
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
}

class CampaignsQueryDto extends RangeQueryDto {
  @IsOptional()
  @IsIn(['SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELED'])
  status?: string;

  @IsOptional() @IsIn(['GROUP', 'CONTACT']) kind?: 'GROUP' | 'CONTACT';

  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('stats')
export class StatsController {
  constructor(private svc: StatsService) {}

  @Get('overview')
  overview(@Query() q: RangeQueryDto) {
    return this.svc.overview(q);
  }

  @Get('instances')
  instances(@Query() q: RangeQueryDto) {
    return this.svc.instances(q);
  }

  @Get('campaigns')
  campaigns(@Query() q: CampaignsQueryDto) {
    return this.svc.campaigns(q);
  }

  @Get('campaigns/:id')
  campaignDetail(@Param('id') id: string, @Query() q: RangeQueryDto) {
    return this.svc.campaignDetail(id, q);
  }
}
