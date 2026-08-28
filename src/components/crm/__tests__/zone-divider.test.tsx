import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZoneDivider } from "../zone-divider";
import type { PipelineZone } from "@/lib/zone-config";

describe("ZoneDivider", () => {
  describe("Horizontal banner layout (Requirement 5.1)", () => {
    it("renders as a horizontal banner with min-height 36px", () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      const divider = screen.getByRole("separator");
      expect(divider).toBeInTheDocument();
      expect(divider).toHaveClass("min-h-[36px]");
    });

    it("renders full-width with w-full class", () => {
      render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={3} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveClass("w-full");
    });

    it("uses horizontal flex layout (not vertical)", () => {
      render(<ZoneDivider zone="SETTLEMENT" campaignCount={2} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveClass("flex");
      expect(divider).toHaveClass("items-center");
      // Should NOT have flex-col (which would make it vertical)
      expect(divider).not.toHaveClass("flex-col");
    });
  });

  describe("ARIA attributes (Requirement 5.6)", () => {
    it('has role="separator"', () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      const divider = screen.getByRole("separator");
      expect(divider).toBeInTheDocument();
    });

    it('has aria-orientation="horizontal"', () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveAttribute("aria-orientation", "horizontal");
    });

    it("has aria-label with zone name", () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveAttribute("aria-label", "영업 존");
    });

    it("has correct aria-label for DEAL_EXECUTION zone", () => {
      render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={3} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveAttribute("aria-label", "딜 진행 존");
    });

    it("has correct aria-label for SETTLEMENT zone", () => {
      render(<ZoneDivider zone="SETTLEMENT" campaignCount={2} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveAttribute("aria-label", "정산 존");
    });
  });

  describe("Zone label and campaign count badge (Requirement 5.2)", () => {
    it("displays zone label text for SALES zone", () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      expect(screen.getByText("영업")).toBeInTheDocument();
    });

    it("displays zone label text for DEAL_EXECUTION zone", () => {
      render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={3} />);

      expect(screen.getByText("딜 진행")).toBeInTheDocument();
    });

    it("displays zone label text for SETTLEMENT zone", () => {
      render(<ZoneDivider zone="SETTLEMENT" campaignCount={2} />);

      expect(screen.getByText("정산")).toBeInTheDocument();
    });

    it("displays campaign count badge", () => {
      render(<ZoneDivider zone="SALES" campaignCount={12} />);

      expect(screen.getByText("12")).toBeInTheDocument();
    });

    it("displays zero campaign count", () => {
      render(<ZoneDivider zone="SALES" campaignCount={0} />);

      expect(screen.getByText("0")).toBeInTheDocument();
    });
  });

  describe("Distinct background color per zone (Requirement 5.4)", () => {
    it("applies blue background for SALES zone", () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveClass("bg-blue-50");
    });

    it("applies amber background for DEAL_EXECUTION zone", () => {
      render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={3} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveClass("bg-amber-50");
    });

    it("applies emerald background for SETTLEMENT zone", () => {
      render(<ZoneDivider zone="SETTLEMENT" campaignCount={2} />);

      const divider = screen.getByRole("separator");
      expect(divider).toHaveClass("bg-emerald-50");
    });

    it("each zone has a different background color", () => {
      const zones: PipelineZone[] = ["SALES", "DEAL_EXECUTION", "SETTLEMENT"];
      const backgrounds: string[] = [];

      for (const zone of zones) {
        const { container } = render(
          <ZoneDivider zone={zone} campaignCount={1} />,
        );
        const divider = container.querySelector('[role="separator"]')!;
        const classes = divider.className;
        // Extract the bg-* class
        const bgClass = classes.split(" ").find((c) => c.startsWith("bg-"));
        backgrounds.push(bgClass || "");
      }

      // All three should be distinct
      const uniqueBackgrounds = new Set(backgrounds);
      expect(uniqueBackgrounds.size).toBe(3);
    });
  });

  describe("Contrast compliance (Requirement 5.4)", () => {
    it("applies dark text color for SALES zone (blue-900 on blue-50)", () => {
      render(<ZoneDivider zone="SALES" campaignCount={5} />);

      const label = screen.getByText("영업");
      expect(label).toHaveClass("text-blue-900");
    });

    it("applies dark text color for DEAL_EXECUTION zone (amber-900 on amber-50)", () => {
      render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={3} />);

      const label = screen.getByText("딜 진행");
      expect(label).toHaveClass("text-amber-900");
    });

    it("applies dark text color for SETTLEMENT zone (emerald-900 on emerald-50)", () => {
      render(<ZoneDivider zone="SETTLEMENT" campaignCount={2} />);

      const label = screen.getByText("정산");
      expect(label).toHaveClass("text-emerald-900");
    });
  });
});
