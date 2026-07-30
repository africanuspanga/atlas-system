import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Optional gating for the detailed health subroutes (audit L2). They expose
 * ops telemetry (worker heartbeats, failed-job counts, outbox backlog) that
 * should not be world-readable in production.
 *
 * - HEALTH_TOKEN unset → no-op (dev convenience; behaviour unchanged).
 * - HEALTH_TOKEN set   → requests need `Authorization: Bearer <HEALTH_TOKEN>`
 *   or get 403 `{ code: 'HEALTH_TOKEN_REQUIRED' }`.
 *
 * Never applied to the bare liveness `GET /health` — load balancers probe it
 * unauthenticated.
 */
@Injectable()
export class HealthTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.HEALTH_TOKEN;
    if (!token) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers.authorization === `Bearer ${token}`) return true;
    throw new ForbiddenException({ code: 'HEALTH_TOKEN_REQUIRED' });
  }
}
