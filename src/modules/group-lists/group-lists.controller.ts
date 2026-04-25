import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { GroupListsService } from './group-lists.service';

class CreateGroupListDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) groupIds?: string[];
}

class GroupIdsDto {
  @IsArray() @IsString({ each: true }) groupIds!: string[];
}

@ApiTags('group-lists')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('group-lists')
export class GroupListsController {
  constructor(private svc: GroupListsService) {}

  @Get() list() { return this.svc.list(); }
  @Get(':id') getOne(@Param('id') id: string) { return this.svc.getOne(id); }
  @Post() create(@Body() dto: CreateGroupListDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: CreateGroupListDto) {
    return this.svc.update(id, dto);
  }
  @Delete(':id') remove(@Param('id') id: string) { return this.svc.remove(id); }

  @Post(':id/groups') addGroups(@Param('id') id: string, @Body() dto: GroupIdsDto) {
    return this.svc.addGroups(id, dto.groupIds);
  }
  @Delete(':id/groups') removeGroups(@Param('id') id: string, @Body() dto: GroupIdsDto) {
    return this.svc.removeGroups(id, dto.groupIds);
  }
}
