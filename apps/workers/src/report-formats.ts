/**
 * File formatters for the reporting module. All figures arrive pre-calculated
 * (and ledger-reconciled) from the report_* SQL functions — this file only
 * lays them out. CSV output is formula-injection-safe per CTO §12.
 */
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";

export interface ReportColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Relative width weight for the PDF table (default 1). */
  weight?: number;
  money?: boolean;
}

export interface ReportLayout {
  title: string;
  schoolName: string;
  reference: string;
  generatedBy: string;
  generatedAt: string;
  /** label/value pairs shown under the title (filters, scope, term…). */
  metadata: Array<[string, string]>;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  /** Rendered bold after the table, e.g. [["Total", "1,250,000"]]. */
  totals: Array<[string, string]>;
  confidential?: boolean;
}

export const formatTZS = (n: unknown): string =>
  `TZS ${new Intl.NumberFormat("en-US").format(Number(n ?? 0))}`;

const cellText = (row: Record<string, unknown>, col: ReportColumn): string => {
  const v = row[col.key];
  if (v === null || v === undefined || v === "") return "—";
  return col.money ? formatTZS(v) : String(v);
};

// ---------------------------------------------------------------------------
// CSV — UTF-8 BOM, quoted, formula-injection-escaped, stable column order.
// ---------------------------------------------------------------------------
export function toCsv(layout: ReportLayout): Buffer {
  const esc = (v: unknown): string => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines: string[] = [];
  lines.push(`"${layout.title} — ${layout.schoolName}"`);
  for (const [label, value] of layout.metadata) lines.push(`${esc(label)},${esc(value)}`);
  lines.push(`"Reference",${esc(layout.reference)}`);
  lines.push(`"Generated",${esc(`${layout.generatedAt} by ${layout.generatedBy}`)}`);
  lines.push("");
  lines.push(layout.columns.map((c) => esc(c.label)).join(","));
  for (const row of layout.rows) {
    lines.push(
      layout.columns
        .map((c) => (c.money ? String(Number(row[c.key] ?? 0)) : esc(row[c.key])))
        .join(","),
    );
  }
  lines.push("");
  for (const [label, value] of layout.totals) lines.push(`${esc(label)},${esc(value)}`);
  return Buffer.from("﻿" + lines.join("\r\n"), "utf8");
}

// ---------------------------------------------------------------------------
// XLSX — typed cells, stable columns, sensible widths.
// ---------------------------------------------------------------------------
export function toXlsx(layout: ReportLayout): Buffer {
  const aoa: unknown[][] = [
    [`${layout.title} — ${layout.schoolName}`],
    ...layout.metadata,
    ["Reference", layout.reference],
    ["Generated", `${layout.generatedAt} by ${layout.generatedBy}`],
    [],
    layout.columns.map((c) => c.label),
    ...layout.rows.map((row) =>
      layout.columns.map((c) => (c.money ? Number(row[c.key] ?? 0) : (row[c.key] ?? ""))),
    ),
    [],
    ...layout.totals,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!cols"] = layout.columns.map((c) => ({ wch: Math.max(c.label.length + 2, 14) }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Report");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ---------------------------------------------------------------------------
// PDF — A4, repeated table headers across pages, page numbers, footer.
// ---------------------------------------------------------------------------
export function toPdf(layout: ReportLayout): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 46, bottom: 56, left: 40, right: 40 },
      bufferPages: true, // needed to stamp "Page N of M" at the end
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 80;
    const weights = layout.columns.map((c) => c.weight ?? 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const colWidths = weights.map((w) => (w / totalWeight) * pageWidth);
    const bottomY = doc.page.height - 72;

    const drawFooter = () => {
      const y = doc.page.height - 46;
      doc.fontSize(7).fillColor("#666");
      doc.text(
        `${layout.reference} · Generated ${layout.generatedAt} by ${layout.generatedBy}` +
          (layout.confidential ? " · CONFIDENTIAL" : ""),
        40, y, { width: pageWidth * 0.8, lineBreak: false },
      );
      doc.fillColor("#000");
    };
    // Page numbers are stamped over all pages at the end via buffered pages.

    const drawTableHeader = (y: number): number => {
      doc.fontSize(8).font("Helvetica-Bold");
      let x = 40;
      layout.columns.forEach((col, i) => {
        doc.text(col.label, x + 2, y, { width: colWidths[i] - 4, align: col.align ?? "left" });
        x += colWidths[i];
      });
      const next = y + 14;
      doc.moveTo(40, next - 3).lineTo(40 + pageWidth, next - 3).lineWidth(0.7).stroke("#333");
      doc.font("Helvetica");
      return next;
    };

    // Header block
    doc.fontSize(15).font("Helvetica-Bold").text(layout.schoolName, 40, 46);
    doc.fontSize(11).font("Helvetica").text(layout.title);
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor("#444");
    for (const [label, value] of layout.metadata) doc.text(`${label}: ${value}`);
    doc.fillColor("#000");
    doc.moveDown(0.6);

    let y = drawTableHeader(doc.y);
    doc.fontSize(8);
    for (const row of layout.rows) {
      const texts = layout.columns.map((c) => cellText(row, c));
      const heights = texts.map((t, i) => doc.heightOfString(t, { width: colWidths[i] - 4 }));
      const rowHeight = Math.max(11, ...heights) + 3;
      if (y + rowHeight > bottomY) {
        drawFooter();
        doc.addPage();
        y = drawTableHeader(50);
      }
      let x = 40;
      texts.forEach((t, i) => {
        doc.text(t, x + 2, y, { width: colWidths[i] - 4, align: layout.columns[i].align ?? "left" });
        x += colWidths[i];
      });
      y += rowHeight;
    }

    // Totals
    y += 6;
    if (y + layout.totals.length * 13 + 10 > bottomY) {
      drawFooter();
      doc.addPage();
      y = 50;
    }
    doc.moveTo(40, y - 3).lineTo(40 + pageWidth, y - 3).lineWidth(0.7).stroke("#333");
    doc.font("Helvetica-Bold").fontSize(9);
    for (const [label, value] of layout.totals) {
      doc.text(label, 40, y, { width: pageWidth * 0.6 });
      doc.text(value, 40 + pageWidth * 0.6, y, { width: pageWidth * 0.4, align: "right" });
      y += 13;
    }
    doc.font("Helvetica");
    drawFooter();

    // Page numbers over every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor("#666").text(
        `Page ${i + 1} of ${range.count}`,
        doc.page.width - 120, doc.page.height - 46,
        { width: 80, align: "right", lineBreak: false },
      );
      doc.fillColor("#000");
    }

    doc.end();
  });
}
