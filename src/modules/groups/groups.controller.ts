import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { GroupsService } from './groups.service';

class SyncGroupsDto {
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
}

class UpdateGroupDto {
  @IsString() @MinLength(8) instanceToken!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() pictureMediaId?: string;
}

class CreateGroupDto {
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsString() @MinLength(2) name!: string;
  @IsArray() @IsString({ each: true }) participants!: string[];
}

@ApiTags('groups')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('groups')
export class GroupsController {
  constructor(private svc: GroupsService) {}

  @Post('sync')
  sync(@Body() dto: SyncGroupsDto) {
    return this.svc.sync(dto.instanceName, dto.instanceToken);
  }

  @Post()
  create(@Body() dto: CreateGroupDto) {
    return this.svc.createGroup(dto.instanceName, dto.instanceToken, dto.name, dto.participants);
  }

  @Get()
  list(@Query('instanceName') instanceName?: string) {
    return this.svc.list(instanceName);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.svc.updateMetadata(id, dto.instanceToken, dto);
  }
}
