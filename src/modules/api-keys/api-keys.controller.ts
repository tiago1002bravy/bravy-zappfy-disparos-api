import { Body, Controller, Delete, Get, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiKeysService } from './api-keys.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class CreateApiKeyDto {
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  // Vincula a key a um usuário do tenant. Quando preenchido, requests via essa
  // key herdam a Conexão WhatsApp do user (refresh manual de shortlinks etc).
  // Default = currentUser, ou null se a request veio de uma API key sem user.
  @IsOptional() @IsString() userId?: string | null;
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
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateApiKeyDto) {
    // userId explícito > currentUser > null
    const userId = dto.userId !== undefined ? dto.userId : (u.userId ?? null);
    return this.svc.create(dto.name, dto.scopes ?? [], userId);
  }

  @Delete(':id')
  revoke(@Param('id') id: string) {
    return this.svc.revoke(id);
  }
}
