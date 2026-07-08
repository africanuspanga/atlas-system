import * as Sentry from '@sentry/node';
import { logger } from './logger';

/**
 * Error alerting. Activated only when SENTRY_DSN is set — with it unset the
 * API runs exactly as before (no SDK network calls). captureError() is safe
 * to call unconditionally.
 */
let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.warn(
      'SENTRY_DSN not set — error alerting disabled (health endpoints still active)',
    );
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // API errors only; performance tracing off to keep quota for alerts.
    tracesSampleRate: 0,
  });
  enabled = true;
  logger.info('Sentry error alerting enabled');
}

export function captureError(
  error: unknown,
  context?: Record<string, string | null>,
): void {
  if (!enabled) return;
  Sentry.captureException(error, { extra: context });
}
