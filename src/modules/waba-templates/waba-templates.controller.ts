import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { WabaTemplatesService } from './waba-templates.service';

class SubscribeWebhookDto {
  @IsString() instanceId!: string;
}

@ApiTags('waba-templates')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('waba-templates')
export class WabaTemplatesController {
  constructor(private svc: WabaTemplatesService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.svc.list(status);
  }

  @Post('sync')
  sync() {
    return this.svc.sync();
  }

  @Post('subscribe-webhook')
  subscribe(@Body() dto: SubscribeWebhookDto) {
    return this.svc.subscribeWebhook(dto.instanceId);
  }
}
