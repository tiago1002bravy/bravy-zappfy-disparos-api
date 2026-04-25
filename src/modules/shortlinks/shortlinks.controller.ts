import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { ShortlinksService } from './shortlinks.service';

class CreateShortlinkDto {
  @IsString() groupId!: string;
  @IsString() @MinLength(2) slug!: string;
  @IsOptional() @IsUrl({ require_protocol: true }) inviteUrl?: string;
  @IsOptional() @IsString() notes?: string;
}

class UpdateShortlinkDto {
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() inviteUrl?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@ApiTags('shortlinks')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('shortlinks')
export class ShortlinksController {
  constructor(private svc: ShortlinksService) {}

  @Get() list() { return this.svc.list(); }
  @Get(':id') getOne(@Param('id') id: string) { return this.svc.getOne(id); }
  @Post() create(@Body() dto: CreateShortlinkDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateShortlinkDto) {
    return this.svc.update(id, dto);
  }
  @Post(':id/refresh') refresh(@Param('id') id: string) {
    return this.svc.refresh(id);
  }
  @Delete(':id') remove(@Param('id') id: string) { return this.svc.remove(id); }
}

/**
 * Endpoint público: redirect 302 pro invite atual.
 * Sem auth, fora do prefixo /api/v1 — registrado no AppModule via setGlobalPrefix exclude.
 */
@ApiTags('public-shortlink')
@Controller('g')
export class PublicShortlinkController {
  constructor(private svc: ShortlinksService) {}

  @Get(':slug')
  async redirect(@Param('slug') slug: string, @Res() res: Response) {
    const url = await this.svc.resolveAndCount(slug);
    if (!url) {
      res.status(404).send('Shortlink not found or inactive');
      return;
    }
    res.redirect(302, url);
  }
}
