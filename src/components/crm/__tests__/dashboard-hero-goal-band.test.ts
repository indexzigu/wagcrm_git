import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveGoalBand,
  GOAL_BAND_TEXT_ON_NAVY,
  GOAL_BAND_FILL_ON_NAVY,
} from "@/lib/goal-band";

/**
 * 데스크톱 홈 히어로가 달성률 색을 **goal-band SSOT 로만** 칠하는지 고정한다.
 *
 * 고친 버그 2종(둘 다 이 파일 안에 공존했다):
 * - 연간·이번달 달성률: 값과 무관하게 **항상 골드**(`text-[#F2C79C]`) — 모바일과 같은 고장.
 * - `ShortageGridRow`: `isUp ? 골드 : white/60` 이라 **방향이 거꾸로**. 초과(방치 가능)가
 *   미달(조치 필요)보다 밝고, 달성률 자체는 `text-white/50` 로 그 줄에서 가장 흐렸다.
 *
 * 이 테스트는 색 값을 다시 단언하지 않는다(그건 goal-band.test.ts 소유). 여기서 막는 건
 * **화면이 자기만의 규칙을 다시 쓰는 것** — 리터럴 골드 hex 재유입과 SSOT 미소비다.
 */

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/crm/dashboard-home.tsx"),
  "utf8",
);

/** 히어로 리터럴 골드 — 밴드를 우회해 값과 무관하게 칠하던 통로 */
const HERO_GOLD_LITERALS = ["#F2C79C", "#E7A567"];

describe("데스크톱 홈 히어로 — 달성 밴드 SSOT 소비", () => {
  it("goal-band SSOT 를 임포트한다", () => {
    expect(SOURCE).toContain('from "@/lib/goal-band"');
    expect(SOURCE).toContain("resolveGoalBand");
    expect(SOURCE).toContain("goalBarWidth");
  });

  it("히어로가 리터럴 골드 hex 를 직접 칠하지 않는다", () => {
    for (const hex of HERO_GOLD_LITERALS) {
      // 캘린더 마커 등은 var(--accent-gold) 토큰을 쓰므로 hex 리터럴은 히어로 잔재뿐이다.
      expect(SOURCE).not.toContain(`text-[${hex}]`);
      expect(SOURCE).not.toContain(`bg-[${hex}]`);
      expect(SOURCE).not.toContain(`text-[${hex}]/70`);
      expect(SOURCE).not.toContain(`bg-[${hex}]/60`);
    }
  });

  it("진행바 너비를 goalBarWidth 로 자른다 (Math.min 직접 계산 금지)", () => {
    expect(SOURCE).not.toContain("Math.min(annualRate ?? 0, 100)");
    expect(SOURCE).not.toContain("Math.min(monthRate ?? 0, 100)");
    expect(SOURCE).toContain("goalBarWidth(annualRate)");
    expect(SOURCE).toContain("goalBarWidth(monthRate)");
  });

  it("ShortageGridRow 의 증감·달성률이 한 밴드에서 색을 받는다", () => {
    // 역전의 원인이던 두 규칙(isUp 삼항 색 · 달성률 고정 white/50)이 사라졌는지
    expect(SOURCE).not.toContain('const colorClass = isUp ? "text-[#F2C79C]" : "text-white/60"');
    expect(SOURCE).not.toContain('<p className="text-xs font-medium text-white/50">{displayRate(rateVal)}</p>');
    expect(SOURCE).toContain("const bandClass = band");
  });
});

describe("밴드 계약 — 데스크톱이 의존하는 부분", () => {
  it("달성/정상/심각이 서로 다른 색을 준다", () => {
    const bands = ["achieved", "normal", "missed"] as const;
    const texts = bands.map((b) => GOAL_BAND_TEXT_ON_NAVY[b]);
    const fills = bands.map((b) => GOAL_BAND_FILL_ON_NAVY[b]);
    expect(new Set(texts).size).toBe(3);
    expect(new Set(fills).size).toBe(3);
  });

  it("112%(초과)와 64%(심각 미달)가 같은 색이 아니다 — 고친 버그의 핵심", () => {
    const over = resolveGoalBand(112);
    const under = resolveGoalBand(64);
    expect(over).toBe("achieved");
    expect(under).toBe("missed");
    expect(GOAL_BAND_TEXT_ON_NAVY[over!]).not.toBe(GOAL_BAND_TEXT_ON_NAVY[under!]);
  });

  it("88%(정상)는 무채색 — 늘 있는 상태라 칠하지 않는다", () => {
    expect(resolveGoalBand(88)).toBe("normal");
    expect(GOAL_BAND_TEXT_ON_NAVY.normal).toContain("white");
  });
});
