import pino from 'pino';

/**
 * Structured JSON logger for the API. One line per request (see
 * LoggingInterceptor) plus explicit error/warn events. Never log secrets,
 * tokens, passwords or request bodies — only identifiers and metadata.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'api', environment: process.env.NODE_ENV ?? 'development' },
});
