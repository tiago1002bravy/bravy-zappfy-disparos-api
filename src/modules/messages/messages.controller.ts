import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { MessagesService } from './messages.service';
import { SchedulesService } from '../schedules/schedules.service';

class MessageMediaDto {
  @IsString() mediaId!: string;
  @IsInt() order!: number;
  @IsOptional() @IsString() kind?: 'AUTO' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'PTT' | 'DOCUMENT';
}

class CreateMessageDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsBoolean() mentionAll?: boolean;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageMediaDto)
  medias?: MessageMediaDto[];
  /** Se preenchido, a mensagem é uma enquete (texto = pergunta, choices = opções) */
  @IsOptional() @IsArray() @ArrayMinSize(2) @IsString({ each: true }) pollChoices?: string[];
  @IsOptional() @IsInt() @Min(1) pollSelectableCount?: number;
}

class SendNowDto {
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) groupRemoteIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) groupListIds?: string[];
}

@ApiTags('messages')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('messages')
export class MessagesController {
  constructor(
    private svc: MessagesService,
    private schedules: SchedulesService,
  ) {}

  @Get() list() {
    return this.svc.list();
  }
  @Get(':id') getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }
  @Post() create(@Body() dto: CreateMessageDto) {
    return this.svc.create(dto);
  }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: CreateMessageDto) {
    return this.svc.update(id, dto);
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Get(':id/active-schedules')
  activeSchedules(@Param('id') id: string) {
    return this.svc.activeSchedules(id);
  }

  /** Dispara a mensagem imediatamente (cria schedule ONCE com startAt=agora). */
  @Post(':id/send-now')
  sendNow(@Param('id') id: string, @Body() dto: SendNowDto) {
    return this.schedules.create({
      messageId: id,
      instanceName: dto.instanceName ?? '',
      instanceToken: dto.instanceToken ?? '',
      groupRemoteIds: dto.groupRemoteIds ?? [],
      groupListIds: dto.groupListIds ?? [],
      type: 'ONCE',
      startAt: new Date().toISOString(),
    });
  }
}
