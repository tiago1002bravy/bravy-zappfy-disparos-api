import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { MediaService } from './media.service';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private svc: MediaService) {}

  // === Endpoint PÚBLICO de proxy (não usa guard nem tenant interceptor). ===
  // Auth via assinatura HMAC na query string. Permite <img src> sem expor MinIO.
  // Definido ANTES de outros @Get pra que NestJS combine a rota mais específica primeiro.
  @Get('raw/:id')
  @SkipThrottle({ default: true, short: true })
  async streamRaw(
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Query('v') variant: 'raw' | 'thumb' | undefined,
    @Res() res: Response,
  ) {
    const v = variant === 'thumb' ? 'thumb' : 'raw';
    const expSec = Number(exp);
    if (!sig || !Number.isFinite(expSec)) {
      throw new BadRequestException('Missing or invalid signature');
    }
    const result = await this.svc.streamSignedMedia(id, expSec, v, sig);
    if (!result) throw new ForbiddenException('Invalid or expired signature');
    if (!result.found) throw new NotFoundException('Media not found');

    res.setHeader('Content-Type', result.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (result.length != null) res.setHeader('Content-Length', String(result.length));
    result.stream.pipe(res);
    result.stream.on('error', (err: Error) => {
      res.destroy(err);
    });
  }

  // === Endpoints autenticados (preservam comportamento original) ===

  @Get()
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor)
  @ApiBearerAuth()
  list(@Query('includeDeleted') includeDeleted?: string) {
    return this.svc.list({ includeDeleted: includeDeleted === 'true' });
  }

  @Get(':id')
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor)
  @ApiBearerAuth()
  getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }

  @Post()
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor, FileInterceptor('file'))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.svc.upload(file);
  }

  @Delete(':id')
  @UseGuards(JwtOrApiKeyGuard)
  @UseInterceptors(TenantInterceptor)
  @ApiBearerAuth()
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
