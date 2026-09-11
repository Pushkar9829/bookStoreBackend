import * as XLSX from "xlsx";

export function parseSpreadsheet(filePath: string): Record<string, string>[] {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.trim().toLowerCase().replace(/\s+/g, "_")] = String(v).trim();
    }
    return out;
  });
}
