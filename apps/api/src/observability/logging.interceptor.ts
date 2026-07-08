import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { logger } from './logger';
import { captureError } from './sentry';

/**
 * Emits one structured log line per request:
 * request_id, tenant_id, user_id, method, route, status_code, duration_ms.
 * The request id is honoured from an incoming x-request-id header (so the
 * web app / a proxy can correlate) and always echoed back on the response.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<
      Request & { user?: { id: string }; tenant?: { tenantId: string } }
    >();
    const res = http.getResponse<Response>();

    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = process.hrtime.bigint();

    const line = (statusCode: number, errorCode?: string) => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const tenantHeader = req.headers['x-tenant-id'];
      logger.info({
        request_id: requestId,
        // Guards populate req.user/req.tenant after this interceptor starts,
        // but this callback runs at response time, so both are visible here.
        user_id: req.user?.id ?? null,
        tenant_id:
          req.tenant?.tenantId ??
          (typeof tenantHeader === 'string' ? tenantHeader : null),
        method: req.method,
        route: req.originalUrl.split('?')[0],
        status_code: statusCode,
        duration_ms: Math.round(durationMs * 10) / 10,
        ...(errorCode ? { error_code: errorCode } : {}),
      });
    };

    return next.handle().pipe(
      tap(() => line(res.statusCode)),
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        const body =
          err instanceof HttpException ? err.getResponse() : undefined;
        const code =
          typeof body === 'object' && body !== null && 'code' in body
            ? String(body.code)
            : err instanceof Error
              ? err.name
              : 'UNKNOWN';
        line(status, code);
        if (status >= 500) {
          captureError(err, {
            request_id: requestId,
            route: req.originalUrl.split('?')[0],
          });
        }
        return throwError(() => err);
      }),
    );
  }
}
