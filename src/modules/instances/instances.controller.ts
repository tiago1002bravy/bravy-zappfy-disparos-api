import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { InstancesService } from './instances.service';

class CreateInstanceDto {
  @IsString() @MinLength(2) label!: string;
  @IsString() @MinLength(8) instanceName!: string;
  @IsString() @MinLength(8) instanceToken!: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
}

class UpdateInstanceDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

@ApiTags('instances')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('instances')
export class InstancesController {
  constructor(private svc: InstancesService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateInstanceDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateInstanceDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/check')
  check(@Param('id') id: string) {
    return this.svc.check(id);
  }
}
