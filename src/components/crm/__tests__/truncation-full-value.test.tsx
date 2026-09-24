// @vitest-environment jsdom
// 말줄임 전체값 접근 계약 — 잘린 값에 도달할 길이 없던 표면들(인터페이스 점검 #14).
//
// 정책: 목록·표는 밀도를 위해 한 줄 말줄임을 유지하되 title 로 전체값에 닿게 하고,
// 헤딩·상세처럼 한 번에 하나만 보이는 자리는 말줄임 대신 줄바꿈한다(터치에는 title 이 없다).
// 판단에 쓰는 값(이체 전 계좌번호, 삭제 판단용 일정명)은 절대 자르지 않는다.
// 자동 조합 캠페인명은 `[딜] - [셀러] N차` 라 원래 길고, 한 줄 말줄임이면 구별 꼬리(회차)가 먼저 잘린다.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EntityIdentity } from "../entity-identity";
import { SellerIdentityInfo } from "../seller-identity-info";

const LONG_CAMPAIGN = "아주 긴 이름의 여름 한정 기획전 딜 - 아주 긴 별칭을 가진 테스트 셀러 12차";
const LONG_SELLER = "아주아주 긴 별칭을 가진 테스트 셀러 이름입니다";

describe("EntityIdentity — 전체값 접근", () => {
  it("목록형(default·compact)은 말줄임을 유지하고 title 에 전체값을 싣는다", () => {
    for (const variant of ["default", "compact"] as const) {
      const { getByText, unmount } = render(
        <EntityIdentity parts={[{ label: "캠페인", value: LONG_CAMPAIGN }]} variant={variant} />,
      );
      const el = getByText(LONG_CAMPAIGN);
      expect(el.className).toContain("truncate");
      expect(el.getAttribute("title")).toBe(LONG_CAMPAIGN);
      unmount();
    }
  });

  it("헤딩은 말줄임하지 않고 줄바꿈해 전체를 보인다", () => {
    const { getByText } = render(
      <EntityIdentity parts={[{ label: "캠페인", value: LONG_CAMPAIGN }]} variant="heading" />,
    );
    const el = getByText(LONG_CAMPAIGN);
    expect(el.className).not.toContain("truncate");
    expect(el.className).toContain("break-words");
  });
});

describe("SellerIdentityInfo — 전체값 접근", () => {
  it("목록형은 셀러명·@계정 모두 title 로 전체값에 닿는다", () => {
    const { getByText } = render(
      <SellerIdentityInfo sellerName={LONG_SELLER} snsType="INSTAGRAM" snsHandle="very_long_handle_name" variant="compact" />,
    );
    const name = getByText(LONG_SELLER);
    expect(name.className).toContain("truncate");
    expect(name.getAttribute("title")).toBe(LONG_SELLER);
    expect(getByText("@very_long_handle_name").getAttribute("title")).toBe("@very_long_handle_name");
  });

  it("헤딩은 셀러명·@계정을 줄바꿈해 전체를 보인다", () => {
    const { getByText } = render(
      <SellerIdentityInfo sellerName={LONG_SELLER} snsType="INSTAGRAM" snsHandle="very_long_handle_name" variant="heading" />,
    );
    const name = getByText(LONG_SELLER);
    expect(name.className).not.toContain("truncate");
    expect(name.className).toContain("break-words");
    // @계정도 같은 줄에서 정책이 갈리지 않게 함께 줄바꿈(공백 없는 토큰이라 break-all)
    const handle = getByText("@very_long_handle_name");
    expect(handle.className).not.toContain("truncate");
    expect(handle.className).toContain("break-all");
  });
});

// 판단용 값 — 모달 전체를 렌더하려면 정산 도메인 목킹이 과해 소스 계약으로 고정한다.
describe("판단용 값은 말줄임하지 않는다(소스 계약)", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");

  it("이체 전 대조 모달의 계좌번호는 break-all 로 전부 보인다", () => {
    const src = read("quick-settlement-modal.tsx");
    const line = src.split("\n").find((l) => l.includes("font-mono") && l.includes("text-sm text-foreground"));
    expect(line, "계좌번호 span 을 찾지 못했다 — 마크업이 바뀌었으면 이 계약도 옮길 것").toBeDefined();
    expect(line).toContain("break-all");
    expect(line).not.toContain("truncate");
  });

  it("삭제 판단용 일정명은 잘리지 않는다", () => {
    const src = read("calendar-orphan-cleanup-dialog.tsx");
    const m = src.match(/<span className="([^"]*)">\s*\{o\.summary\}/);
    expect(m, "일정명 span 을 찾지 못했다 — 마크업이 바뀌었으면 이 계약도 옮길 것").not.toBeNull();
    expect(m![1]).not.toContain("truncate");
  });
});
