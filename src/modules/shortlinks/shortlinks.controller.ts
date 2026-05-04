import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
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
import { ShortlinksService } from './shortlinks.service';
import { ShortlinksResolver } from './shortlinks.resolver';
import { GeoResolverService } from './geo-resolver.service';

const STRATEGIES = ['SEQUENTIAL', 'ROUND_ROBIN', 'RANDOM'] as const;
const CAPACITY_SOURCES = ['ZAPPFY', 'CLICK_COUNT'] as const;
const ITEM_STATUSES = ['ACTIVE', 'FULL', 'INVALID', 'DISABLED'] as const;

class CreateShortlinkDto {
  @IsString() @MinLength(2) slug!: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) groupIds!: string[];
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(STRATEGIES) strategy?: (typeof STRATEGIES)[number];
  @IsOptional() @IsInt() @Min(10) @Max(1024) hardCap?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1024) initialClickBudget?: number;
  @IsOptional() @IsEnum(CAPACITY_SOURCES) capacitySource?: (typeof CAPACITY_SOURCES)[number];
  @IsOptional() @IsBoolean() autoCreate?: boolean;
  @IsOptional() @IsString() autoCreateInstance?: string;
  @IsOptional() @IsString() autoCreateTemplate?: string;
}

class UpdateShortlinkDto {
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsEnum(STRATEGIES) strategy?: (typeof STRATEGIES)[number];
  @IsOptional() @IsInt() @Min(10) @Max(1024) hardCap?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1024) initialClickBudget?: number;
  @IsOptional() @IsEnum(CAPACITY_SOURCES) capacitySource?: (typeof CAPACITY_SOURCES)[number];
  @IsOptional() @IsBoolean() autoCreate?: boolean;
  @IsOptional() @IsString() autoCreateInstance?: string;
  @IsOptional() @IsString() autoCreateTemplate?: string;
}

class AddItemsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) groupIds!: string[];
}

class UpdateItemDto {
  @IsOptional() @IsInt() @Min(0) order?: number;
  @IsOptional() @IsEnum(ITEM_STATUSES) status?: (typeof ITEM_STATUSES)[number];
}

class ReorderItemsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) itemIds!: string[];
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
  @Delete(':id') remove(@Param('id') id: string) { return this.svc.remove(id); }

  @Post(':id/items') addItems(@Param('id') id: string, @Body() dto: AddItemsDto) {
    return this.svc.addItems(id, dto.groupIds);
  }
  @Patch(':id/items/:itemId') updateItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.svc.updateItem(id, itemId, dto);
  }
  @Delete(':id/items/:itemId') removeItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.svc.removeItem(id, itemId);
  }
  @Post(':id/items/reorder') reorder(@Param('id') id: string, @Body() dto: ReorderItemsDto) {
    return this.svc.reorderItems(id, dto.itemIds);
  }
  @Post(':id/items/:itemId/refresh') refresh(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.svc.refreshItem(id, itemId);
  }
}

/**
 * Endpoint público: redirect 302 pro invite atual.
 * Sem auth, fora do prefixo /api/v1 — registrado no AppModule via setGlobalPrefix exclude.
 */
@ApiTags('public-shortlink')
@Controller('g')
export class PublicShortlinkController {
  constructor(
    private resolver: ShortlinksResolver,
    private geo: GeoResolverService,
  ) {}

  @Get(':slug')
  async redirect(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ip = extractIp(req);
    const ua = req.headers['user-agent'] ?? null;
    const result = await this.resolver.resolve(slug, { ip, userAgent: ua ?? undefined });

    if (result.ok) {
      // Geo lookup async (nao bloqueia redirect)
      if (ip && result.clickId) this.geo.enqueue(result.clickId, ip);
      res.redirect(302, result.inviteUrl);
      return;
    }

    if (result.reason === 'not-found') {
      res.status(404).send('Shortlink not found');
    } else {
      res.status(503).send('Sem grupo disponivel no momento. Tente novamente em alguns minutos.');
    }
  }
}

function extractIp(req: Request): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff[0]) return String(xff[0]).split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}
