import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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
  @IsOptional() @IsBoolean() applyDefaults?: boolean;
}

class AddParticipantsDto {
  @IsString() @MinLength(8) instanceToken!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) participants!: string[];
  /** Se true (default), promove os adicionados a admin após adicionar */
  @IsOptional() @IsBoolean() asAdmin?: boolean;
}

class ParticipantsActionDto {
  @IsString() @MinLength(8) instanceToken!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) participants!: string[];
}

class PermissionsDto {
  @IsString() @MinLength(8) instanceToken!: string;
  @IsOptional() @IsBoolean() locked?: boolean;
  @IsOptional() @IsBoolean() announce?: boolean;
}

class PictureDto {
  @IsString() @MinLength(8) instanceToken!: string;
  @IsOptional() @IsString() mediaId?: string;
  @IsOptional() @IsString() dataUri?: string;
  @IsOptional() @IsString() imageUrl?: string;
}

class AlsoCreateListDto {
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsHexColor() color?: string;
}

class AlsoCreateShortlinkDto {
  @IsString() @MinLength(2) slug!: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsIn(['SEQUENTIAL', 'ROUND_ROBIN', 'RANDOM']) strategy?: 'SEQUENTIAL' | 'ROUND_ROBIN' | 'RANDOM';
  @IsOptional() @IsInt() @Min(1) hardCap?: number;
  @IsOptional() @IsInt() @Min(1) initialClickBudget?: number;
}

class BulkCreateDto {
  @IsString() @MinLength(2) nameTemplate!: string;
  @IsInt() @Min(0) startNumber!: number;
  @IsInt() @Min(1) @Max(50) count!: number;
  @IsOptional() @IsString() instanceName?: string;
  @IsOptional() @IsString() instanceToken?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) initialParticipants?: string[];
  @IsOptional() @IsBoolean() applyDefaults?: boolean;
  @IsOptional() @IsInt() @Min(1000) @Max(60000) delayMs?: number;
  @IsOptional() @ValidateNested() @Type(() => AlsoCreateListDto) alsoCreateList?: AlsoCreateListDto;
  @IsOptional() @ValidateNested() @Type(() => AlsoCreateShortlinkDto) alsoCreateShortlink?: AlsoCreateShortlinkDto;
}

class BulkApplyDto {
  @IsString() @MinLength(8) instanceToken!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) groupIds!: string[];
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() pictureMediaId?: string;
  @IsOptional() @IsString() pictureDataUri?: string;
  @IsOptional() @IsString() pictureUrl?: string;
  @IsOptional() @IsBoolean() locked?: boolean;
  @IsOptional() @IsBoolean() announce?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) addAdmins?: string[];
  @IsOptional() @IsInt() @Min(1000) @Max(60000) delayMs?: number;
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
    return this.svc.createGroup(
      dto.instanceName,
      dto.instanceToken,
      dto.name,
      dto.participants,
      { applyDefaults: dto.applyDefaults },
    );
  }

  @Post('bulk-create')
  bulkCreate(@Body() dto: BulkCreateDto) {
    return this.svc.bulkCreate(dto);
  }

  @Post('bulk-apply')
  bulkApply(@Body() dto: BulkApplyDto) {
    const { instanceToken, ...rest } = dto;
    return this.svc.bulkApply(instanceToken, rest);
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

  @Post(':id/participants')
  addParticipants(@Param('id') id: string, @Body() dto: AddParticipantsDto) {
    return this.svc.addParticipants(id, dto.instanceToken, dto.participants, dto.asAdmin ?? true);
  }

  @Post(':id/participants/promote')
  promote(@Param('id') id: string, @Body() dto: ParticipantsActionDto) {
    return this.svc.updateParticipants(id, dto.instanceToken, 'promote', dto.participants);
  }

  @Post(':id/participants/demote')
  demote(@Param('id') id: string, @Body() dto: ParticipantsActionDto) {
    return this.svc.updateParticipants(id, dto.instanceToken, 'demote', dto.participants);
  }

  @Post(':id/participants/remove')
  remove(@Param('id') id: string, @Body() dto: ParticipantsActionDto) {
    return this.svc.updateParticipants(id, dto.instanceToken, 'remove', dto.participants);
  }

  @Post(':id/permissions')
  permissions(@Param('id') id: string, @Body() dto: PermissionsDto) {
    return this.svc.setPermissions(id, dto.instanceToken, {
      locked: dto.locked,
      announce: dto.announce,
    });
  }

  @Post(':id/picture')
  picture(@Param('id') id: string, @Body() dto: PictureDto) {
    return this.svc.setPicture(id, dto.instanceToken, {
      mediaId: dto.mediaId,
      dataUri: dto.dataUri,
      imageUrl: dto.imageUrl,
    });
  }
}
