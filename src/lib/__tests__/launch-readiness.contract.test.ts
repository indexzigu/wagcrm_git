import { describe, expect, it } from "vitest";
import {
  auditLaunchReadiness,
  type ReadinessInput,
} from "@/lib/offer/launch-readiness";

/**
 * 공구 오픈 준비 감사(C2 M4)의 판정 계약.
 *
 * 이 감사가 지켜야 하는 선:
 * - **BLOCK 은 사고 축, FIX 는 성과 축이다.** 법령·계정 리스크(금지 표현·필수
 *   고지 누락)만 BLOCK 이고, 오퍼가 약한 것은 열려도 사고가 아니라 FIX 다.
 *   이 구분이 흐려지면 운영자가 BLOCK 을 무시하는 법부터 배운다.
 * - **새 노동을 만들지 않는다** — 입력은 전부 이미 있는 자동 판정이다
 *   (오너가 체크리스트 기반 배지를 실측 근거로 기각했다, `campaign-setup.ts`).
 * - **미실행은 감사에서 빠진다** — 진단을 안 돌린 것이 실패로 잡히면 안 된다.
 */

const CLEAN: ReadinessInput = {
  claimGates: [
    { label: "셀러용 자료", gate: { verdict: "PASS", violations: [], missingDisclosures: [] } },
  ],
  offer: {
    rows: [
      {
        id: "PRICE_ADVANTAGE",
        label: "가격 우위",
        verdict: "PASS",
        reason: "",
        fix: null,
      },
    ],
    coverage: { decided: 1, applicable: 1 },
    score: 10,
  },
  needsOrderRegistration: false,
  needsChannelAssignment: false,
  daysUntilStart: 5,
};

const violation = (severity: "BLOCK" | "WARN") => ({
  sourceId: "r1",
  origin: "GLOBAL_RULE" as const,
  severity,
  matched: "완치",
  span: [0, 2] as [number, number],
  legalBasis: "식품표시광고법",
});

describe("auditLaunchReadiness", () => {
  it("걸리는 것이 없으면 SHIP", () => {
    const r = auditLaunchReadiness(CLEAN);
    expect(r.level).toBe("SHIP");
    expect(r.items).toHaveLength(0);
  });

  it("판매 시작까지 남은 일수를 그대로 전달한다", () => {
    expect(auditLaunchReadiness({ ...CLEAN, daysUntilStart: 2 }).daysUntilStart).toBe(2);
    expect(auditLaunchReadiness({ ...CLEAN, daysUntilStart: null }).daysUntilStart).toBeNull();
  });

  it("모든 항목은 무엇을 하면 풀리는지 알려준다", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "셀러용 자료",
          gate: {
          verdict: "BLOCK",
          violations: [violation("BLOCK")],
          missingDisclosures: [{ id: "d1", text: "유료 광고 표기" }],
          },
        },
      ],
      needsChannelAssignment: true,
    });
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      expect(item.fix, `${item.source} 에 수정 안내가 없다`).toBeTruthy();
    }
  });
});

describe("BLOCK 은 사고 축만 — 법령·계정 리스크", () => {
  it("금지 표현(게이트 BLOCK)은 BLOCK", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "셀러용 자료",
          gate: {
          verdict: "BLOCK",
          violations: [violation("BLOCK")],
          missingDisclosures: [],
          },
        },
      ],
    });
    expect(r.level).toBe("BLOCK");
    expect(r.items[0].source).toBe("CLAIMS");
  });

  it("필수 고지 누락은 표현이 깨끗해도 BLOCK", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "셀러용 자료",
          gate: {
          verdict: "PASS",
          violations: [],
          missingDisclosures: [{ id: "d1", text: "유료 광고 표기" }],
          },
        },
      ],
    });
    expect(r.level).toBe("BLOCK");
  });

  it("주의(WARN) 표현은 BLOCK 이 아니라 FIX", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "셀러용 자료",
          gate: {
          verdict: "WARN",
          violations: [violation("WARN")],
          missingDisclosures: [],
          },
        },
      ],
    });
    expect(r.level).toBe("FIX");
  });
});

describe("오퍼가 약한 것은 성과 축 — FIX", () => {
  it("오퍼 FAIL 은 FIX 이고 BLOCK 으로 올라가지 않는다", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      offer: {
        rows: [
          {
            id: "BUNDLE_DIFF",
            label: "구성 차별",
            verdict: "FAIL",
            reason: "",
            fix: "구성을 만드세요",
          },
        ],
        coverage: { decided: 1, applicable: 1 },
        score: 0,
      },
    });
    expect(r.level).toBe("FIX");
    expect(r.items[0].message).toContain("구성 차별");
  });

  it("미확인 행이 있으면 FIX 로 알린다 (실패로 잡지 않는다)", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      offer: {
        rows: [
          {
            id: "RISK_REVERSAL",
            label: "위험 역전",
            verdict: "UNKNOWN",
            reason: "",
            fix: "확인하세요",
          },
        ],
        coverage: { decided: 0, applicable: 1 },
        score: null,
      },
    });
    expect(r.level).toBe("FIX");
    expect(r.items[0].message).toContain("미확인 1행");
  });
});

describe("미실행 판정은 감사에서 빠진다", () => {
  it("표현 게이트·오퍼 진단을 안 돌렸으면 그것 때문에 걸리지 않는다", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [],
      offer: null,
    });
    expect(r.level).toBe("SHIP");
    expect(r.items).toHaveLength(0);
  });
});

describe("세팅 판정 (기존 신호 재사용)", () => {
  it("채널 미지정이 등록보다 먼저다 — 채널을 알아야 등록 필요 여부가 정해진다", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      needsChannelAssignment: true,
      needsOrderRegistration: true,
    });
    const setupItems = r.items.filter((i) => i.source === "SETUP");
    expect(setupItems).toHaveLength(1);
    expect(setupItems[0].message).toContain("판매채널");
  });

  it("자사 스토어 미등록은 FIX", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      needsOrderRegistration: true,
    });
    expect(r.level).toBe("FIX");
    expect(r.items[0].message).toContain("주문관리");
  });
});

/**
 * 표현 게이트의 **검사 범위** 계약 (오너 결정 2026-08-02).
 *
 * 가이드 2원화로 소비자에게 닿는 자료가 둘이 됐다(셀러용·브랜드용). 오너 결정은
 * **B안 — 브랜드용도 판정에 포함**이다: 그쪽도 소비자에게 닿으므로 셀러용과 달리
 * 볼 이유가 없고, "보여주기만 하는 경고"는 결국 무시된다.
 *
 * ⚠️ 이 감사는 판정 함수(`checkText`)도 금지어 사전도 건드리지 않는다 — 같은 규칙을
 * 자료마다 한 번씩 돌릴 뿐이다. 유형별로 severity 를 다르게 보는 것(WARN→BLOCK)은
 * 공유 게이트의 의미를 바꾸는 별개 결정이고, 오너 판단으로 **보류**됐다.
 */
describe("표현 게이트 범위 — 브랜드용 자료도 판정 대상이다", () => {
  const clean = { verdict: "PASS" as const, violations: [], missingDisclosures: [] };

  it("브랜드용만 걸려도 캠페인은 BLOCK 이다", () => {
    // 종전 구조에서는 이 상황이 SHIP 이었다 — 브랜드용이 감사에 없었기 때문이다.
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        { label: "셀러용 자료", gate: clean },
        {
          label: "브랜드용 자료",
          gate: {
            verdict: "BLOCK",
            violations: [violation("BLOCK")],
            missingDisclosures: [],
          },
        },
      ],
    });
    expect(r.level).toBe("BLOCK");
    expect(r.items.some((i) => i.source === "CLAIMS")).toBe(true);
  });

  it("둘 다 검사되면 항목이 **어느 자료**인지 밝힌다", () => {
    // 유형이 둘 이상일 때 문구에 자료명이 없으면, 운영자가 셀러용을 고치고
    // 브랜드용이 걸린 줄 모른 채 다시 조회한다.
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "셀러용 자료",
          gate: { verdict: "WARN", violations: [violation("WARN")], missingDisclosures: [] },
        },
        {
          label: "브랜드용 자료",
          gate: { verdict: "BLOCK", violations: [violation("BLOCK")], missingDisclosures: [] },
        },
      ],
    });
    const claims = r.items.filter((i) => i.source === "CLAIMS");
    expect(claims).toHaveLength(2);
    expect(claims.some((i) => i.message.includes("셀러용 자료"))).toBe(true);
    expect(claims.some((i) => i.message.includes("브랜드용 자료"))).toBe(true);
  });

  it("검사된 자료가 하나뿐이면 자료명을 붙이지 않는다 — 불필요한 수식은 소음이다", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "셀러용 자료",
          gate: { verdict: "BLOCK", violations: [violation("BLOCK")], missingDisclosures: [] },
        },
      ],
    });
    expect(r.items[0].message).not.toContain("셀러용 자료");
    expect(r.items[0].message).toContain("금지 표현");
  });

  it("한쪽이 없어도 있는 쪽은 판정된다 — 부재가 통과가 되지 않는다", () => {
    const r = auditLaunchReadiness({
      ...CLEAN,
      claimGates: [
        {
          label: "브랜드용 자료",
          gate: { verdict: "PASS", violations: [], missingDisclosures: [{ id: "d1", text: "유료 광고 표기" }] },
        },
      ],
    });
    expect(r.level).toBe("BLOCK");
  });
});
