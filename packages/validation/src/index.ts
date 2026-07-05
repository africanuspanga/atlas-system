import { z } from "zod";

/** Tanzania-first defaults; other countries configurable later. */
export const DEFAULTS = {
  currency: "TZS",
  timezone: "Africa/Dar_es_Salaam",
  languages: ["en", "sw"] as const,
} as const;

export const languageSchema = z.enum(["en", "sw"]);

export const tenantSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens only");

export const createTenantSchema = z.object({
  name: z.string().min(2).max(200),
  slug: tenantSlugSchema,
  schoolTypes: z
    .array(z.enum(["pre_primary", "primary", "o_level_secondary", "a_level_secondary"]))
    .min(1),
  isBoarding: z.boolean().default(false),
  country: z.string().default("TZ"),
  region: z.string().max(100).optional(),
  district: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email(),
  defaultLanguage: languageSchema.default("en"),
  currency: z.string().length(3).default(DEFAULTS.currency),
  timezone: z.string().default(DEFAULTS.timezone),
});

export const createCampusSchema = z.object({
  name: z.string().min(2).max(200),
  code: z.string().min(1).max(20),
  isMain: z.boolean().default(false),
  address: z.string().max(500).optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  roleKeys: z.array(z.string().min(1)).min(1),
  campusIds: z.array(z.string().uuid()).optional(),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type CreateCampusInput = z.infer<typeof createCampusSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
