/**
 * Central registry of ATLAS queue names.
 *
 * Every job payload MUST carry tenant context — background work is never
 * allowed to run without knowing which tenant it belongs to.
 */
export const QUEUES = {
  notifications: "notifications",
  reports: "reports",
  imports: "imports",
  billing: "billing",
  reconciliation: "reconciliation",
  exports: "exports",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface TenantJobContext {
  tenantId: string;
  campusId?: string;
  /** User who triggered the job, for audit trails. Null for system jobs. */
  actorUserId: string | null;
  requestId?: string;
}

export interface TenantJob<TPayload = unknown> {
  context: TenantJobContext;
  payload: TPayload;
}
