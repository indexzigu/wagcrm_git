import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CSVImportDialog } from "../csv-import-dialog";

describe("csv-import-dialog", () => {
  it("renders a dialog description for bulk import guidance", () => {
    render(
      <CSVImportDialog
        open
        onOpenChange={() => {}}
        entityType="partners"
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText(
        "CSV 파일을 업로드해 거래처 데이터를 일괄 등록하거나 갱신합니다.",
      ),
    ).toBeInTheDocument();
  });
});
