import * as XLSX from 'xlsx';

/**
 * File parsing for the import pipeline. SheetJS handles .xlsx/.xls/.csv
 * (including ;- and tab-delimited CSV) uniformly. Values are read as
 * FORMATTED TEXT (raw:false) so phone numbers and admission numbers keep
 * their leading zeros; nothing here evaluates formulas or runs macros.
 */

export const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
export const MAX_ROWS = 5000;

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

export class ImportParseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseImportFile(buffer: Buffer, filename: string): ParsedSheet {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      raw: false, // formatted text — preserves leading zeros
      cellFormula: false,
      cellHTML: false,
      dense: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unreadable file';
    if (/password|encrypted/i.test(message)) {
      throw new ImportParseError(
        'IMPORT_FILE_ENCRYPTED',
        'Encrypted workbooks are not supported',
      );
    }
    throw new ImportParseError('IMPORT_FILE_UNREADABLE', message);
  }

  // First sheet with content wins; hidden/empty sheets are skipped.
  const sheetName = workbook.SheetNames.find((name) => {
    const sheet = workbook.Sheets[name];
    return sheet && sheet['!ref'];
  });
  if (!sheetName) {
    throw new ImportParseError(
      'IMPORT_FILE_EMPTY',
      `No data found in ${filename}`,
    );
  }

  const grid: string[][] = XLSX.utils.sheet_to_json(
    workbook.Sheets[sheetName],
    {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    },
  );
  if (grid.length < 2) {
    throw new ImportParseError(
      'IMPORT_FILE_EMPTY',
      'File needs a header row and at least one data row',
    );
  }

  // Headers: trimmed; blanks become col_N; duplicates get _2, _3 …
  const seen = new Map<string, number>();
  const headers = grid[0].map((raw, i) => {
    let h = String(raw ?? '').trim() || `col_${i + 1}`;
    const n = (seen.get(h.toLowerCase()) ?? 0) + 1;
    seen.set(h.toLowerCase(), n);
    if (n > 1) h = `${h}_${n}`;
    return h;
  });

  const dataRows = grid.slice(1);
  if (dataRows.length > MAX_ROWS) {
    throw new ImportParseError(
      'IMPORT_TOO_MANY_ROWS',
      `File has ${dataRows.length} rows; the limit is ${MAX_ROWS}. Split the file.`,
    );
  }

  const rows = dataRows
    .map((cells) => {
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = String(cells[i] ?? '').trim();
      });
      return row;
    })
    .filter((row) => Object.values(row).some((v) => v !== ''));

  if (rows.length === 0) {
    throw new ImportParseError('IMPORT_FILE_EMPTY', 'All data rows are empty');
  }

  return { headers, rows };
}
