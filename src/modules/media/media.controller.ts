import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { TenantInterceptor } from '../../common/interceptors/tenant.interceptor';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(TenantInterceptor)
@Controller('media')
export class MediaController {
  constructor(private svc: MediaService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.svc.getOne(id);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.svc.upload(file);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
