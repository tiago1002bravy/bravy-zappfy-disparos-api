import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { ContactsService } from './contacts.service';

class ListContactsQueryDto {
  @IsOptional() @IsIn(['LEAD', 'BUYER']) kind?: 'LEAD' | 'BUYER';
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}

class TriggerSyncDto {
  @IsOptional() @IsBoolean() full?: boolean;
}

@ApiTags('contacts')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('contacts')
export class ContactsController {
  constructor(private svc: ContactsService) {}

  @Get()
  list(@Query() q: ListContactsQueryDto) {
    return this.svc.list(q);
  }

  @Get('counts')
  counts() {
    return this.svc.counts();
  }

  @Post('sync')
  sync(@Body() dto: TriggerSyncDto) {
    return this.svc.triggerSync(dto.full ?? false);
  }
}
