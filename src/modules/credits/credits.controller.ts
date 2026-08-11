import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { CreditsService } from './credits.service';

class CreateCreditDto {
  @IsString() instanceId!: string;
  // USD; negativo permite ajuste manual do ledger
  @Type(() => Number) @IsNumber() amountUsd!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

@ApiTags('credits')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('credits')
export class CreditsController {
  constructor(private svc: CreditsService) {}

  @Get()
  list(@Query('instanceId') instanceId?: string) {
    return this.svc.list(instanceId);
  }

  @Post()
  create(@Body() dto: CreateCreditDto) {
    return this.svc.create(dto);
  }
}
