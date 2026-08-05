import { getDict, type Translator } from "@atlas/i18n";

/**
 * ATLAS ships in English only — there is no language state and no switcher.
 * This stays a hook (rather than a bare import) so every screen keeps one call
 * shape for copy, and the shared string catalogue remains the single place
 * copy is reviewed.
 */
const t: Translator = getDict();

export function useT(): Translator {
  return t;
}
