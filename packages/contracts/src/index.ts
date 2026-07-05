/**
 * ATLAS shared contracts.
 *
 * These types are the single vocabulary shared by the web dashboard,
 * the NestJS API, the workers and (later) the mobile apps.
 */

export type TenantStatus =
  | "draft"
  | "configuration"
  | "data_review"
  | "training"
  | "live"
  | "suspended"
  | "archived";

export type MembershipStatus = "invited" | "active" | "suspended" | "revoked";

export type SchoolType =
  | "pre_primary"
  | "primary"
  | "o_level_secondary"
  | "a_level_secondary"
  | "combined";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  country: string;
  region: string | null;
  district: string | null;
  defaultLanguage: "en" | "sw";
  currency: string;
  timezone: string;
  createdAt: string;
}

export interface Campus {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  isMain: boolean;
  status: "active" | "inactive";
}

export interface TenantMembership {
  id: string;
  tenantId: string;
  userId: string;
  status: MembershipStatus;
  campusIds: string[] | null;
  roles: string[];
}

/**
 * Granular permission keys use the `domain.action` convention, e.g.
 * `students.view`, `attendance.mark`, `finance.periods.lock`.
 */
export type PermissionKey = string;

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown>;
  };
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
  };
}
