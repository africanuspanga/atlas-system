/**
 * Standard Tanzanian A-Level (ACSEE) subject combination presets: three
 * principal subjects plus General Studies (non-principal, taken by every
 * A-Level student). Subject codes reference SUBJECT_PRESETS.a_level — the
 * preset endpoint resolves them per tenant and SKIPS any combination whose
 * subjects are not all present (e.g. HKL needs Literature 'LIT' and ECA needs
 * Commerce 'COM' / Accountancy 'ACC', which schools add as custom subjects).
 */
export interface CombinationPreset {
  code: string;
  name: string;
  subjects: Array<{ code: string; isPrincipal: boolean }>;
}

const GENERAL_STUDIES = { code: 'GS', isPrincipal: false };
const principals = (...codes: string[]) =>
  codes.map((code) => ({ code, isPrincipal: true }));

export const COMBINATION_PRESETS: CombinationPreset[] = [
  {
    code: 'PCM',
    name: 'Physics, Chemistry, Mathematics',
    subjects: [...principals('PHY', 'CHE', 'ADM'), GENERAL_STUDIES],
  },
  {
    code: 'PCB',
    name: 'Physics, Chemistry, Biology',
    subjects: [...principals('PHY', 'CHE', 'BIO'), GENERAL_STUDIES],
  },
  {
    code: 'CBG',
    name: 'Chemistry, Biology, Geography',
    subjects: [...principals('CHE', 'BIO', 'GEO'), GENERAL_STUDIES],
  },
  {
    code: 'EGM',
    name: 'Economics, Geography, Mathematics',
    subjects: [...principals('ECO', 'GEO', 'ADM'), GENERAL_STUDIES],
  },
  {
    code: 'HGE',
    name: 'History, Geography, Economics',
    subjects: [...principals('HIS', 'GEO', 'ECO'), GENERAL_STUDIES],
  },
  {
    code: 'HGL',
    name: 'History, Geography, English Language',
    subjects: [...principals('HIS', 'GEO', 'ENG'), GENERAL_STUDIES],
  },
  {
    code: 'HKL',
    name: 'History, Kiswahili, Literature',
    subjects: [...principals('HIS', 'KIS', 'LIT'), GENERAL_STUDIES],
  },
  {
    code: 'ECA',
    name: 'Economics, Commerce, Accountancy',
    subjects: [...principals('ECO', 'COM', 'ACC'), GENERAL_STUDIES],
  },
];
