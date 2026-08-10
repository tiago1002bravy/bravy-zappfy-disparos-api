import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { FlowsService } from './flows.service';
import { FlowConfig } from './flow-config';

class CreateFlowDto {
  @IsString() @MinLength(2) name!: string;
  @IsString() @Matches(/^[a-z0-9-]{3,60}$/) slug!: string;
  @IsString() instanceId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1440) everyMinutes?: number;
  @IsOptional() @IsArray() @Matches(/^\d{2}:\d{2}$/, { each: true }) times?: string[];
  @IsObject() config!: FlowConfig;
  @IsOptional() @IsBoolean() active?: boolean;
}

class UpdateFlowDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() instanceId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1440) everyMinutes?: number;
  @IsOptional() @IsArray() @Matches(/^\d{2}:\d{2}$/, { each: true }) times?: string[];
  @IsOptional() @IsObject() config?: FlowConfig;
}

@ApiTags('flows')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('flows')
export class FlowsController {
  constructor(private svc: FlowsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateFlowDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFlowDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.svc.runNow(id);
  }
}

class HookBodyDto {
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() nome?: string;
}

/** Webhook público por fluxo (ex: Kirvano compra aprovada). Auth via x-flow-secret. */
@ApiTags('flows')
@SkipThrottle()
@Controller('hooks/flows')
export class FlowHooksController {
  constructor(private svc: FlowsService) {}

  @Post(':slug')
  @HttpCode(200)
  ingest(
    @Param('slug') slug: string,
    @Headers('x-flow-secret') secret: string | undefined,
    @Body() body: HookBodyDto,
  ) {
    return this.svc.ingestWebhook(slug, secret, body);
  }
}
