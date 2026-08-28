import Papa from "papaparse";

/**
 * Exports data as a CSV file download in the browser.
 *
 * @param data - Array of objects to export
 * @param columns - Column definitions with key and header label
 * @param filename - Download filename (should end with .csv)
 */
export function exportToCSV<T extends Record<string, unknown>>(
  data: T[],
  columns: Array<{ key: keyof T; label: string }>,
  filename: string,
) {
  const headers = columns.map((col) => col.label);
  const rows = data.map((row) =>
    columns.map((col) => {
      const value = row[col.key];
      if (value == null) return "";
      if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
      }
      if (typeof value === "number") {
        return String(value);
      }
      return String(value);
    }),
  );

  const csv = Papa.unparse({
    fields: headers,
    data: rows,
  });

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generates a filename with today's date.
 */
export function csvFilename(entityType: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${entityType}-export-${date}.csv`;
}
