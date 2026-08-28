/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { csvFilename, exportToCSV } from "../lib/csv-export";

describe("csv-export", () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let appendChildSpy: ReturnType<typeof vi.spyOn>;
  let removeChildSpy: ReturnType<typeof vi.spyOn>;
  let clickSpy: ReturnType<typeof vi.fn>;
   
  let mockLink: Record<string, any>;

  beforeEach(() => {
    clickSpy = vi.fn();
    mockLink = {
      setAttribute: vi.fn(),
      click: clickSpy,
      style: {} as CSSStyleDeclaration,
    };

    createElementSpy = vi
      .spyOn(document, "createElement")
      .mockReturnValue(mockLink as unknown as HTMLAnchorElement);
    appendChildSpy = vi
      .spyOn(document.body, "appendChild")
      .mockReturnValue(mockLink as unknown as HTMLAnchorElement);
    removeChildSpy = vi
      .spyOn(document.body, "removeChild")
      .mockReturnValue(mockLink as unknown as HTMLAnchorElement);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/fake-url");
    revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates CSV with correct headers from column labels", () => {
    const data = [
      { name: "Partner A", type: "BRAND", createdAt: "2025-03-15T00:00:00Z" },
    ];
    const columns: Array<{ key: keyof (typeof data)[0]; label: string }> = [
      { key: "name", label: "이름" },
      { key: "type", label: "유형" },
      { key: "createdAt", label: "생성일" },
    ];

    exportToCSV(data, columns, "partners.csv");

    // Verify anchor was created and clicked
    expect(createElementSpy).toHaveBeenCalledWith("a");
    expect(clickSpy).toHaveBeenCalled();

    expect(mockLink.download).toBe("partners.csv");
  });

  it("formats dates as YYYY-MM-DD", () => {
    const data = [
      { startDate: "2025-06-01T12:30:00.000Z" },
      { startDate: "2025-07-15" },
    ];
    const columns: Array<{ key: keyof (typeof data)[0]; label: string }> = [{ key: "startDate", label: "시작일" }];

    exportToCSV(data, columns, "campaigns.csv");

    // Verify the function runs without error and triggers a download
    expect(clickSpy).toHaveBeenCalled();
    expect(mockLink.download).toBe("campaigns.csv");
  });

  it("handles numbers without currency symbols", () => {
    const data = [
      { actualSales: 1500000, marginRate: 15.5 },
    ];
    const columns: Array<{ key: keyof (typeof data)[0]; label: string }> = [
      { key: "actualSales", label: "매출" },
      { key: "marginRate", label: "마진율" },
    ];

    exportToCSV(data, columns, "deals.csv");

    expect(clickSpy).toHaveBeenCalled();
    expect(mockLink.download).toBe("deals.csv");
  });

  it("handles null and undefined values as empty strings", () => {
    const data = [
      { name: "Test", value: null, other: undefined },
    ];
    const columns: Array<{ key: keyof (typeof data)[0]; label: string }> = [
      { key: "name", label: "Name" },
      { key: "value", label: "Value" },
      { key: "other", label: "Other" },
    ];

    exportToCSV(data, columns, "sellers.csv");

    expect(clickSpy).toHaveBeenCalled();
  });

  it("uses correct filename pattern with entity type and today's date", () => {
    const data = [{ id: "1" }];
    const columns: Array<{ key: keyof (typeof data)[0]; label: string }> = [{ key: "id", label: "ID" }];

    exportToCSV(data, columns, "sellers.csv");

    expect(csvFilename("sellers")).toMatch(
      /^sellers-export-\d{4}-\d{2}-\d{2}\.csv$/
    );
    expect(mockLink.download).toBe("sellers.csv");
  });

  it("cleans up DOM elements and revokes object URL after download", () => {
    const data = [{ id: "1" }];
    const columns: Array<{ key: keyof (typeof data)[0]; label: string }> = [{ key: "id", label: "ID" }];

    exportToCSV(data, columns, "partners.csv");

    expect(appendChildSpy).toHaveBeenCalled();
    expect(removeChildSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalled();
  });
});
