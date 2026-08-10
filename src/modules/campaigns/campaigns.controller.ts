import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { CampaignsService } from './campaigns.service';

class CreateCampaignDto {
  @IsString() @MinLength(2) name!: string;
  @IsString() templateId!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) templateVariables?: string[];
  @IsOptional() @IsUrl({ require_tld: false }) headerMediaUrl?: string;
  @IsIn(['LEAD', 'BUYER', 'ALL']) audienceKind!: 'LEAD' | 'BUYER' | 'ALL';
  @IsOptional() @IsArray() @IsString({ each: true }) contactIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) instanceIds?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(600) throttlePerMinute?: number;
  @IsOptional() @IsISO8601() startAt?: string;
}

class CampaignActionDto {
  @IsIn(['pause', 'resume', 'cancel']) action!: 'pause' | 'resume' | 'cancel';
}

class ListMessagesQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED'])
  status?: string;

  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}

@ApiTags('campaigns')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('campaigns')
export class CampaignsController {
  constructor(private svc: CampaignsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateCampaignDto) {
    return this.svc.create(dto);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }

  @Get(':id/messages')
  messages(@Param('id') id: string, @Query() q: ListMessagesQueryDto) {
    return this.svc.listMessages(id, q);
  }

  @Patch(':id')
  action(@Param('id') id: string, @Body() dto: CampaignActionDto) {
    return this.svc.applyAction(id, dto.action);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
