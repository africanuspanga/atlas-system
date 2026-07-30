import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';

/**
 * Global 5xx response scrubber (audit M2).
 *
 * Many controllers wrap upstream failures as
 * `InternalServerErrorException({ code, message: error.message })` — those
 * messages are raw Postgres/PostgREST strings and leak schema details
 * (table/column/constraint names) to clients. Rather than edit every
 * controller, this filter rewrites any response with status >= 500 to
 * `{ code }` only, after logging the full original body (and stack) server
 * side. The stable `code` field is preserved so clients can still branch;
 * anything without one becomes `INTERNAL`.
 *
 * Statuses < 500 (business errors like `{ code: 'SEAT_LIMIT_REACHED' }`)
 * pass through untouched via Nest's default handling.
 *
 * Sentry capture is unaffected: LoggingInterceptor's catchError re-throws
 * before this filter runs, so 5xx errors are already captured with the
 * original exception (see observability/logging.interceptor.ts). Guard-phase
 * errors skip the interceptor but are 4xx and pass through here unchanged.
 */
@Catch()
export class Http500ScrubFilter extends BaseExceptionFilter {
  private readonly scrubLogger = new Logger(Http500ScrubFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // Non-5xx HttpExceptions keep Nest's default behaviour exactly.
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      super.catch(exception, host);
      return;
    }

    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const body =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const code =
      typeof body === 'object' && body !== null && 'code' in body
        ? String(body.code)
        : 'INTERNAL';
    const detail =
      body !== undefined
        ? JSON.stringify(body)
        : exception instanceof Error
          ? exception.message
          : JSON.stringify(exception);

    // Full detail server-side only; the client sees just the stable code.
    this.scrubLogger.error(
      `${req.method} ${req.originalUrl.split('?')[0]} ${status} ${code} — ` +
        `original: ${detail}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    res.status(status).json({ code });
  }
}
