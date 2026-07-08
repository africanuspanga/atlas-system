/**
 * Per-domain import contracts: which ATLAS fields exist, which uploaded
 * headers map to them (EN + SW synonyms), and how values are normalised.
 * Validation itself lives in imports.controller.ts — this file is pure data
 * + parsing helpers so it stays unit-testable.
 */

export type ImportDomain = 'students' | 'opening_balances';

export interface DomainField {
  key: string;
  label: string;
  required: boolean;
  /** Normalised header synonyms (lowercase, single-spaced, no punctuation). */
  synonyms: string[];
}

export const DOMAIN_FIELDS: Record<ImportDomain, DomainField[]> = {
  students: [
    {
      key: 'fullName',
      label: 'Full name',
      required: false, // required as a group: fullName OR firstName+lastName
      synonyms: [
        'jina kamili',
        'jina la mwanafunzi',
        'full name',
        'name',
        'majina',
        'student name',
      ],
    },
    {
      key: 'firstName',
      label: 'First name',
      required: false,
      synonyms: ['jina la kwanza', 'first name', 'firstname'],
    },
    {
      key: 'middleName',
      label: 'Middle name',
      required: false,
      synonyms: ['jina la kati', 'middle name', 'middlename'],
    },
    {
      key: 'lastName',
      label: 'Last name',
      required: false,
      synonyms: [
        'jina la mwisho',
        'jina la ukoo',
        'surname',
        'last name',
        'lastname',
      ],
    },
    {
      key: 'gender',
      label: 'Gender',
      required: true,
      synonyms: ['jinsia', 'gender', 'sex'],
    },
    {
      key: 'dateOfBirth',
      label: 'Date of birth',
      required: false,
      synonyms: [
        'tarehe ya kuzaliwa',
        'dob',
        'date of birth',
        'birth date',
        'birthdate',
      ],
    },
    {
      key: 'boardingStatus',
      label: 'Day/Boarding',
      required: false,
      synonyms: ['bweni', 'boarding', 'day boarding', 'boarding status'],
    },
    {
      key: 'className',
      label: 'Class',
      required: false,
      synonyms: ['darasa', 'class', 'form', 'kidato', 'grade'],
    },
    {
      key: 'stream',
      label: 'Stream',
      required: false,
      synonyms: ['mkondo', 'stream', 'section'],
    },
    {
      key: 'guardianName',
      label: 'Guardian name',
      required: false,
      synonyms: [
        'jina la mzazi',
        'mzazi',
        'mlezi',
        'guardian name',
        'parent name',
        'guardian',
        'parent',
        'jina la mzazi mlezi',
      ],
    },
    {
      key: 'guardianPhone',
      label: 'Guardian phone',
      required: false,
      synonyms: [
        'simu ya mzazi',
        'simu',
        'phone',
        'guardian phone',
        'parent phone',
        'mobile',
        'namba ya simu',
        'phone number',
      ],
    },
    {
      key: 'guardianEmail',
      label: 'Guardian email',
      required: false,
      synonyms: ['barua pepe', 'email', 'guardian email', 'parent email'],
    },
    {
      key: 'guardianRelationship',
      label: 'Relationship',
      required: false,
      synonyms: ['uhusiano', 'relationship'],
    },
  ],
  opening_balances: [
    {
      key: 'studentNumber',
      label: 'Student number',
      required: true,
      synonyms: [
        'namba ya mwanafunzi',
        'namba',
        'student number',
        'admission no',
        'admission number',
        'adm no',
        'reg no',
        'student no',
      ],
    },
    {
      key: 'amount',
      label: 'Opening balance (TZS)',
      required: true,
      synonyms: [
        'salio',
        'kiasi',
        'amount',
        'balance',
        'opening balance',
        'deni',
        'salio la awali',
      ],
    },
    {
      key: 'description',
      label: 'Description',
      required: false,
      synonyms: ['maelezo', 'description', 'note', 'notes'],
    },
    {
      key: 'asOfDate',
      label: 'As-of date',
      required: false,
      synonyms: ['tarehe', 'date', 'as of', 'as of date'],
    },
  ],
};

/** Which existing permission gates job creation for a domain. */
export const DOMAIN_PERMISSION: Record<ImportDomain, string> = {
  students: 'students.create',
  opening_balances: 'finance.invoices.create',
};

export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MappingSuggestion {
  field: string | null;
  confidence: 'high' | 'medium' | 'none';
}

/** Suggests an ATLAS field for one uploaded header. Never commits anything. */
export function suggestField(
  header: string,
  domain: ImportDomain,
  taken: Set<string>,
): MappingSuggestion {
  const norm = normalizeHeader(header);
  if (!norm) return { field: null, confidence: 'none' };
  for (const field of DOMAIN_FIELDS[domain]) {
    if (taken.has(field.key)) continue;
    if (field.synonyms.includes(norm))
      return { field: field.key, confidence: 'high' };
  }
  for (const field of DOMAIN_FIELDS[domain]) {
    if (taken.has(field.key)) continue;
    if (field.synonyms.some((s) => norm.includes(s) || s.includes(norm))) {
      return { field: field.key, confidence: 'medium' };
    }
  }
  return { field: null, confidence: 'none' };
}

// ---------------------------------------------------------------------------
// Value normalisers
// ---------------------------------------------------------------------------

const MALE = new Set(['m', 'male', 'me', 'mume', 'mvulana', 'boy', 'kiume']);
const FEMALE = new Set([
  'f',
  'female',
  'ke',
  'mke',
  'msichana',
  'girl',
  'kike',
]);

export function normalizeGender(value: string): 'male' | 'female' | null {
  const v = value.trim().toLowerCase();
  if (MALE.has(v)) return 'male';
  if (FEMALE.has(v)) return 'female';
  return null;
}

/**
 * Tanzanian phone numbers: keep as STRINGS (leading zero preserved).
 * Normalises +255/255 prefixes to the local 0-prefixed form.
 */
export function normalizePhone(value: string): {
  phone: string;
  valid: boolean;
} {
  let digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+255')) digits = '0' + digits.slice(4);
  else if (digits.startsWith('255') && digits.length === 12)
    digits = '0' + digits.slice(3);
  digits = digits.replace(/\D/g, '');
  return { phone: digits, valid: /^0\d{9}$/.test(digits) };
}

/** Accepts ISO, dd/mm/yyyy, dd-mm-yyyy and Excel date serials → ISO or null. */
export function parseDate(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(v);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += year > 50 ? 1900 : 2000;
    return toIso(year, Number(dmy[2]), Number(dmy[1]));
  }
  // Excel serial date (days since 1899-12-30)
  if (/^\d{4,5}$/.test(v)) {
    const serial = Number(v);
    if (serial > 10000 && serial < 60000) {
      const ms = (serial - 25569) * 86400 * 1000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    year < 1900 ||
    year > 2100
  )
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return date.toISOString().slice(0, 10);
}

/** Parses "1,250,000", "TZS 1250000", "1250000.50" → number or null. */
export function parseAmount(value: string): number | null {
  const cleaned = value.replace(/tzs|tsh|shs?|,|\s/gi, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "Amina Hassan Juma" → first/middle/last. Single names are rejected. */
export function splitFullName(
  value: string,
): { firstName: string; middleName: string | null; lastName: string } | null {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length === 2)
    return { firstName: parts[0], middleName: null, lastName: parts[1] };
  return {
    firstName: parts[0],
    middleName: parts.slice(1, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}
