import * as XLSX from 'xlsx';

/**
 * File parsing for the import pipeline. SheetJS handles .xlsx/.xls/.csv
 * (including ;- and tab-delimited CSV) uniformly. Values are read as
 * FORMATTED TEXT (raw:false) so phone numbers and admission numbers keep
 * their leading zeros; nothing here evaluates formulas or runs macros.
 */

export const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
export const MAX_ROWS = 5000;

/**
 * Decompression ceiling for zip-container workbooks (.xlsx/.xlsm).
 *
 * `XLSX.read` inflates and materialises the ENTIRE workbook before any row cap
 * can be applied, so `MAX_ROWS` is not a defence against a small, highly
 * compressible file. Measured against the vendored xlsx@0.20.3 on this repo: a
 * 1.68 MB .xlsx (comfortably under the controller's 4 MB `MAX_FILE_BYTES`)
 * inflated to hundreds of MB of sheet XML, held the single-threaded Node event
 * loop for ~93 s and pushed RSS to ~2.5 GB. For that minute and a half the API
 * serves nothing — for every tenant, not just the uploader.
 *
 * A zip's central directory records each entry's UNCOMPRESSED size, so the
 * expansion can be priced before a single byte is inflated. 25 MB of sheet XML
 * is far more than MAX_ROWS of real school data ever produces.
 */
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

/** Reject absurd expansion even below the absolute ceiling. */
const MAX_COMPRESSION_RATIO = 200;

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

/**
 * Sum the uncompressed sizes recorded in a zip's central directory without
 * inflating anything. Returns null when the buffer is not a zip (a CSV, or an
 * old BIFF .xls), which the caller treats as "no container to price".
 */
function uncompressedZipSize(buffer: Buffer): number | null {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== ZIP_LOCAL_SIG) {
    return null;
  }

  // The End Of Central Directory record sits at the tail, before an optional
  // comment of up to 64 KiB. Scan backwards for its signature.
  const scanFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ImportParseError(
      'IMPORT_FILE_UNREADABLE',
      'Workbook container is malformed (no zip directory)',
    );
  }

  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let total = 0;

  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== ZIP_CD_SIG) break;

    const uncompressed = buffer.readUInt32LE(offset + 24);
    // 0xFFFFFFFF means the real size lives in a ZIP64 extra field. Nothing a
    // school roster produces needs ZIP64 — refuse rather than parse it.
    if (uncompressed === 0xffffffff) {
      throw new ImportParseError(
        'IMPORT_FILE_TOO_LARGE',
        'Workbook is too large to process. Split the file.',
      );
    }
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) return total; // short-circuit

    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return total;
}

/** Price the decompression before doing it. Throws if the file is a bomb. */
function assertSafeToInflate(buffer: Buffer): void {
  const uncompressed = uncompressedZipSize(buffer);
  if (uncompressed === null) return;

  if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw new ImportParseError(
      'IMPORT_FILE_TOO_LARGE',
      `Workbook expands to ${Math.round(uncompressed / 1024 / 1024)} MB, over the ` +
        `${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB limit. Split the file.`,
    );
  }
  if (
    buffer.length > 0 &&
    uncompressed / buffer.length > MAX_COMPRESSION_RATIO
  ) {
    throw new ImportParseError(
      'IMPORT_FILE_TOO_LARGE',
      'Workbook compression ratio is implausible for spreadsheet data.',
    );
  }
}

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
  // Price the expansion BEFORE SheetJS inflates anything. This is the only
  // check that actually bounds the work; everything below runs after the whole
  // workbook is already in memory.
  assertSafeToInflate(buffer);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      raw: false, // formatted text — preserves leading zeros
      cellFormula: false,
      cellHTML: false,
      dense: true,
      // Secondary bound: stop materialising past the row cap. Header + one row
      // over MAX_ROWS, so the MAX_ROWS check below still trips (and still
      // reports a useful message) rather than silently truncating the import.
      sheetRows: MAX_ROWS + 2,
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
  // `sheetRows` above stops SheetJS at MAX_ROWS + 2, so this sees at most one
  // row past the cap and cannot report the file's true length — say "more
  // than" rather than quoting a truncated count as if it were the total.
  if (dataRows.length > MAX_ROWS) {
    throw new ImportParseError(
      'IMPORT_TOO_MANY_ROWS',
      `File has more than ${MAX_ROWS} rows, which is the limit. Split the file.`,
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
