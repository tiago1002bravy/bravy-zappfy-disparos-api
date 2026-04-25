import { Body, Controller, Delete, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiKeysService } from './api-keys.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';

class CreateApiKeyDto {
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
}

@ApiTags('api-keys')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('api-keys')
export class ApiKeysController {
  constructor(private svc: ApiKeysService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateApiKeyDto) {
    return this.svc.create(dto.name, dto.scopes ?? []);
  }

  @Delete(':id')
  revoke(@Param('id') id: string) {
    return this.svc.revoke(id);
  }
}
