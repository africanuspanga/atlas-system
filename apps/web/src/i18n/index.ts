// The dictionaries and translator moved to the shared @atlas/i18n package
// so web and mobile stay in lockstep (one EN/SW key set, zero drift).
// All existing "@/i18n" imports keep working through this re-export.
export * from "@atlas/i18n";
