import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    const { method, originalUrl } = req;

    res.on('finish', () => {
      const ms = Date.now() - start;
      const len = res.getHeader('content-length') ?? '-';
      const line = `${method} ${originalUrl} ${res.statusCode} ${ms}ms ${len}b`;
      if (res.statusCode >= 500 || ms > 5000) this.logger.warn(line);
      else this.logger.log(line);
    });

    next();
  }
}
