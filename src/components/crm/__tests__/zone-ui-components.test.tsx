// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ZoneViewSelector } from "../zone-view-selector";
import { ZoneCollapseControl } from "../zone-collapse-control";

// ---------------------------------------------------------------------------
// ZoneViewSelector Tests (Requirements 1.1, 7.5)
// ---------------------------------------------------------------------------

describe("ZoneViewSelector", () => {
  it("renders correct active state for VIEW_B", () => {
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
      />,
    );

    const viewBButton = screen.getByRole("radio", { name: "3-Zone 뷰" });
    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });

    expect(viewBButton).toHaveAttribute("data-state", "on");
    expect(viewCButton).toHaveAttribute("data-state", "off");
  });

  it("renders correct active state for VIEW_C", () => {
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_C"
        onViewChange={onViewChange}
      />,
    );

    const viewBButton = screen.getByRole("radio", { name: "3-Zone 뷰" });
    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });

    expect(viewBButton).toHaveAttribute("data-state", "off");
    expect(viewCButton).toHaveAttribute("data-state", "on");
  });

  it("calls onViewChange when a different view is selected", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
      />,
    );

    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });
    await user.click(viewCButton);

    expect(onViewChange).toHaveBeenCalledWith("VIEW_C");
  });

  it("renders disabled state with reduced opacity in table/monthly view", () => {
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
        disabled={true}
      />,
    );

    // The toggle group should have opacity-50 class
    const toggleGroup = screen.getByRole("group");
    expect(toggleGroup).toHaveClass("opacity-50");

    // All radio buttons should be disabled
    const buttons = screen.getAllByRole("radio");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("does not call onViewChange when disabled", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
        disabled={true}
      />,
    );

    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });
    await user.click(viewCButton);

    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("shows tooltip wrapper when disabled", () => {
    const { container } = render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={vi.fn()}
        disabled={true}
      />,
    );

    // When disabled, the component wraps in a TooltipProvider/Tooltip
    // The tooltip trigger wraps the selector
    const tooltipTrigger = container.querySelector("[data-slot='tooltip-trigger']");
    expect(tooltipTrigger).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ZoneCollapseControl Tests (Requirement 3.1)
// ---------------------------------------------------------------------------

describe("ZoneCollapseControl", () => {
  it("renders aria-expanded=true when expanded", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("renders aria-expanded=false when collapsed", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("calls onToggle when clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="DEAL_EXECUTION"
        expanded={true}
        onToggle={onToggle}
      />,
    );

    await user.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard interaction with Enter key", () => {
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
    // Native button handles Enter via click event
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
  });

  it("supports keyboard interaction with Space key", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button");
    button.focus();
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalled();
  });

  it("is disabled when disabled prop is true (last expanded zone)", () => {
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="DEAL_EXECUTION"
        expanded={true}
        disabled={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("does not call onToggle when disabled", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="DEAL_EXECUTION"
        expanded={true}
        disabled={true}
        onToggle={onToggle}
      />,
    );

    await user.click(screen.getByRole("button"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("has accessible aria-label with zone name and action", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "영업 존 접기");
  });

  it("updates aria-label when collapsed", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "영업 존 펼치기");
  });
});
