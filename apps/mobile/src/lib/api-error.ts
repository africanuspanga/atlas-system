import type { DictKey, Translator } from "@atlas/i18n";

/**
 * Maps the API's stable business-error codes to translated messages so end
 * users never see raw codes like `PLAN_LIMIT_STAFF` or `HTTP 500`.
 * Ported from apps/web/src/lib/api-error.ts — keep the two in sync.
 */
const ERROR_KEYS: Partial<Record<string, DictKey>> = {
  // Plan / subscription enforcement (tenant.guard + invitations)
  PLAN_LIMIT_STAFF: "err.planLimitStaff",
  PLAN_LIMIT_STUDENTS: "err.planLimitStudents",
  SUBSCRIPTION_EXPIRED: "err.subscriptionExpired",
  NO_SUBSCRIPTION: "err.noSubscription",
  TENANT_SUSPENDED: "err.tenantSuspended",
  TENANT_ARCHIVED: "err.tenantArchived",
  // Invitations
  INVITE_INVALID_OR_EXPIRED: "err.inviteInvalid",
  INVITE_TOKEN_INVALID: "err.inviteInvalid",
  INVITE_EMAIL_MISMATCH: "err.inviteEmailMismatch",
  // Finance
  PAYMENT_EXCEEDS_BALANCE: "err.paymentExceedsBalance",
  // Assessments
  SCORES_ASSESSMENT_PUBLISHED: "err.assessmentPublished",
  // Attendance
  ATTENDANCE_DUPLICATE_STUDENT: "err.attendanceDuplicate",
  ATTENDANCE_STUDENT_NOT_ENROLLED: "err.attendanceNotEnrolled",
  // Timetable
  TIMETABLE_TEACHER_CLASH: "err.teacherClash",
  // Onboarding
  ONBOARDING_SLUG_TAKEN: "err.slugTaken",
  // Hostel (kept in sync with the module's original ERROR_KEYS)
  HOSTEL_NOT_BOARDER: "hostel.err.notBoarder",
  HOSTEL_GENDER_MISMATCH: "hostel.err.genderMismatch",
  HOSTEL_ROOM_FULL: "hostel.err.roomFull",
  // Generic families
  INTERNAL: "err.server",
};

/** Translate an API error body + HTTP status into a user-facing message. */
export function apiErrorMessage(
  t: Translator,
  body: { code?: string; message?: string } | null | undefined,
  status: number,
): string {
  const code = typeof body?.code === "string" ? body.code : undefined;
  if (code) {
    const exact = ERROR_KEYS[code];
    if (exact) return t(exact);
    if (code.endsWith("_NOT_FOUND")) return t("err.notFound");
    if (code.endsWith("_INVALID")) return t("err.invalid");
    if (code.endsWith("_FAILED")) return t("err.server");
    return `${t("err.generic")} (${code})`;
  }
  if (status === 429) return t("err.rateLimited");
  if (status === 401) return t("err.unauthorized");
  if (status === 403) return t("err.forbidden");
  if (status === 404) return t("err.notFound");
  if (status >= 500) return t("err.server");
  return `${t("err.generic")} (HTTP ${status})`;
}
