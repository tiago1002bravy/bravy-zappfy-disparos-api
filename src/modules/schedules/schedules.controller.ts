import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ScheduleType } from '@prisma/client';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { SchedulesService } from './schedules.service';

class CreateScheduleDto {
  @IsString() messageId!: string;
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) groupRemoteIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) groupListIds?: string[];
  @IsEnum(ScheduleType) type!: ScheduleType;
  @IsDateString() startAt!: string;
  @IsOptional() @IsDateString() endAt?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() time?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays?: number[];
  @IsOptional() @IsString() cron?: string;
}

class PatchScheduleDto {
  @IsOptional() @IsString() action?: 'pause' | 'resume' | 'cancel';
  // Campos de reagendamento (editar)
  @IsOptional() @IsString() messageId?: string;
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) groupRemoteIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) groupListIds?: string[];
  @IsOptional() @IsEnum(ScheduleType) type?: ScheduleType;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsDateString() endAt?: string | null;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() time?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) weekdays?: number[];
  @IsOptional() @IsString() cron?: string;
}

@ApiTags('schedules')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('schedules')
export class SchedulesController {
  constructor(private svc: SchedulesService) {}

  @Get() list() {
    return this.svc.list();
  }
  @Get(':id') getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }
  @Get(':id/executions') executions(@Param('id') id: string) {
    return this.svc.listExecutions(id);
  }
  @Post() create(@Body() dto: CreateScheduleDto) {
    return this.svc.create(dto);
  }
  @Patch(':id') async patch(@Param('id') id: string, @Body() dto: PatchScheduleDto) {
    if (dto.action === 'pause') return this.svc.pause(id);
    if (dto.action === 'resume') return this.svc.resume(id);
    if (dto.action === 'cancel') return this.svc.cancel(id);
    // Reagendar (qualquer outro campo presente)
    const editableKeys = [
      'messageId', 'instanceName', 'instanceToken', 'groupRemoteIds',
      'type', 'startAt', 'endAt', 'timezone', 'time', 'weekdays', 'cron',
    ] as const;
    const hasEdit = editableKeys.some((k) => dto[k] !== undefined);
    if (hasEdit) return this.svc.reschedule(id, dto);
    return this.svc.getOne(id);
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
