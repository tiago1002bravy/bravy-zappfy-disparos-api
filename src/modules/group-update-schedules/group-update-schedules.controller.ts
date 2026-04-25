import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GroupUpdateTarget, ScheduleType } from '@prisma/client';
import {
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
import { GroupUpdateSchedulesService } from './group-update-schedules.service';

class CreateGroupUpdateDto {
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsString() groupRemoteId!: string;
  @IsEnum(GroupUpdateTarget) target!: GroupUpdateTarget;
  @IsOptional() @IsString() newName?: string;
  @IsOptional() @IsString() newDescription?: string;
  @IsOptional() @IsString() newPictureMediaId?: string;
  @IsEnum(ScheduleType) type!: ScheduleType;
  @IsDateString() startAt!: string;
  @IsOptional() @IsString() time?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays?: number[];
  @IsOptional() @IsString() cron?: string;
  @IsOptional() @IsString() timezone?: string;
}

class PatchGroupUpdateDto {
  @IsOptional() @IsString() action?: 'cancel';
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsOptional() @IsString() groupRemoteId?: string;
  @IsOptional() @IsEnum(GroupUpdateTarget) target?: GroupUpdateTarget;
  @IsOptional() @IsString() newName?: string;
  @IsOptional() @IsString() newDescription?: string;
  @IsOptional() @IsString() newPictureMediaId?: string;
  @IsOptional() @IsEnum(ScheduleType) type?: ScheduleType;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsString() time?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) weekdays?: number[];
  @IsOptional() @IsString() cron?: string;
  @IsOptional() @IsString() timezone?: string;
}

class RunNowGroupUpdateDto {
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsString() groupRemoteId!: string;
  @IsEnum(GroupUpdateTarget) target!: GroupUpdateTarget;
  @IsOptional() @IsString() newName?: string;
  @IsOptional() @IsString() newDescription?: string;
  @IsOptional() @IsString() newPictureMediaId?: string;
}

@ApiTags('group-update-schedules')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('group-update-schedules')
export class GroupUpdateSchedulesController {
  constructor(private svc: GroupUpdateSchedulesService) {}

  @Get() list() {
    return this.svc.list();
  }
  @Get(':id') getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }
  @Post() create(@Body() dto: CreateGroupUpdateDto) {
    return this.svc.create(dto);
  }
  @Patch(':id') patch(@Param('id') id: string, @Body() dto: PatchGroupUpdateDto) {
    if (dto.action === 'cancel') return this.svc.cancel(id);
    const editableKeys = [
      'instanceName', 'instanceToken', 'groupRemoteId', 'target',
      'newName', 'newDescription', 'newPictureMediaId',
      'type', 'startAt', 'time', 'weekdays', 'cron', 'timezone',
    ] as const;
    const hasEdit = editableKeys.some((k) => (dto as Record<string, unknown>)[k] !== undefined);
    if (hasEdit) return this.svc.reschedule(id, dto);
    return this.svc.getOne(id);
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  /** Aplica a alteração de grupo agora (cria schedule ONCE com startAt=agora). */
  @Post('run-now')
  runNow(@Body() dto: RunNowGroupUpdateDto) {
    return this.svc.runNow(dto);
  }
}
