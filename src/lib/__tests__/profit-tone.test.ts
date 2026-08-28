import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveProfitTone,
  PROFIT_TONE_TEXT,
  PROFIT_TONE_TEXT_DENSE,
} from "../profit-tone";
import { cn } from "../utils";

describe("resolveProfitTone", () => {
  it("음수만 loss", () => {
    expect(resolveProfitTone(-1)).toBe("loss");
    expect(resolveProfitTone(-2_300_000)).toBe("loss");
    expect(resolveProfitTone(-0.1)).toBe("loss");
  });

  it("0 은 흑자 — 손실이 아니므로 경고를 띄우지 않는다", () => {
    expect(resolveProfitTone(0)).toBe("profit");
  });

  it("양수는 profit", () => {
    expect(resolveProfitTone(1)).toBe("profit");
    expect(resolveProfitTone(6_900_000)).toBe("profit");
  });

  it("값이 없거나 유한하지 않으면 null (호출부가 무채색 유지)", () => {
    expect(resolveProfitTone(null)).toBeNull();
    expect(resolveProfitTone(undefined)).toBeNull();
    expect(resolveProfitTone(NaN)).toBeNull();
    expect(resolveProfitTone(Infinity)).toBeNull();
  });
});

describe("PROFIT_TONE_TEXT — 축 계약", () => {
  it("흑자/적자가 서로 다른 색", () => {
    expect(PROFIT_TONE_TEXT.profit).not.toBe(PROFIT_TONE_TEXT.loss);
  });

  it("적자에 money-out 을 쓰지 않는다 — 그 토큰은 자금 방향축(반대편)이다", () => {
    // globals.css 가 "지급은 위험이 아니라서 --status-urgent 에 흡수할 수 없다"고 선언한 축.
    // 그 역도 참이라 손익 판정에 자금 방향축을 빌려 쓰면 안 된다.
    expect(PROFIT_TONE_TEXT.loss).not.toContain("money-out");
    expect(PROFIT_TONE_TEXT.loss).toContain("status-urgent");
  });

  it("흑자는 자금축 -text 변형을 쓴다 (status-success 아님)", () => {
    expect(PROFIT_TONE_TEXT.profit).toContain("money-in-text");
    expect(PROFIT_TONE_TEXT.profit).not.toContain("status-success");
  });
});

describe("PROFIT_TONE_TEXT_DENSE — 밀도 축 계약", () => {
  it("흑자 키가 없다 — 밀집 표면의 흑자는 색을 받지 않는다", () => {
    // 누락이 아니라 선언이다. "대칭을 맞추자"며 profit 을 채우면 열 전체가 초록이 되고
    // 적자가 묻힌다(P8 §2). 이 단언이 그 되돌림을 잡는다.
    expect(PROFIT_TONE_TEXT_DENSE.profit).toBeUndefined();
    expect(Object.keys(PROFIT_TONE_TEXT_DENSE)).toEqual(["loss"]);
  });

  it("적자는 초점과 같은 토큰 — 밀도는 흑자만 가른다", () => {
    // 표면이 같으면(흰 카드) 대비 계산도 같다(P8 §5). 밀도가 적자의 세기까지 낮추면
    // 정작 봐야 할 신호가 약해진다 — 이 축이 존재하는 목적과 반대다.
    expect(PROFIT_TONE_TEXT_DENSE.loss).toBe(PROFIT_TONE_TEXT.loss);
  });

  it("적자에 money-out 을 쓰지 않는다 — 초점 맵과 같은 축 규율", () => {
    expect(PROFIT_TONE_TEXT_DENSE.loss).not.toContain("money-out");
    expect(PROFIT_TONE_TEXT_DENSE.loss).toContain("status-urgent");
  });

  /**
   * ⚠️ 밀도 축이 만든 **새 충돌면**이다. 초점 맵은 흑자·적자 둘 다 색을 내서 항상
   * 마지막에 이겼지만, 밀집 맵은 흑자에서 `undefined` 를 낸다 — 그러면 같은 요소에
   * 얹힌 위계색(`accent` 의 `text-primary`, `strong` 의 `text-slate-900`)이 그대로
   * 드러난다. 거기까진 의도다. **문제는 적자다**: 위계색이 적자색을 이기면 마이너스가
   * 네이비로 떠서 조용히 감춰진다 — 이 축이 존재하는 목적과 정반대다.
   *
   * `cn()`(tailwind-merge)이 "같은 요소·같은 속성이면 뒤가 이긴다"로 풀어 주지만,
   * 그건 **소비처가 tone 을 마지막에 놓았을 때만** 참이다. 순서가 뒤집히거나 위계색이
   * 나중에 추가되면 조용히 깨지고 tsc·eslint·렌더 스냅샷 어느 것도 잡지 못한다.
   * (실제로 `campaign-side-panel` 의 「매출총이익」이 `accent strong amount` 3종을
   * 한 요소에 얹은 자리다.)
   */
  it("위계색이 적자색을 이기지 않는다 — accent·strong 과 겹쳐도 적자가 보인다", () => {
    const loss = PROFIT_TONE_TEXT_DENSE.loss as string;
    expect(cn("text-primary", loss)).toContain("text-status-urgent-text");
    expect(cn("text-primary", loss)).not.toContain("text-primary");
    expect(cn("text-slate-900", loss)).not.toContain("text-slate-900");
    expect(cn("text-money-out", loss)).not.toContain("text-money-out");
  });

  it("반대로 흑자는 위계색을 지운다 — 밀집 흑자는 무색이지 무스타일이 아니다", () => {
    // `undefined` 를 얹어도 앞의 위계색이 살아남아야 한다(「매출총이익」의 accent 네이비).
    expect(cn("text-primary", PROFIT_TONE_TEXT_DENSE.profit)).toContain("text-primary");
  });
});

describe("globals.css — --money-in-text 토큰 계약 (D1)", () => {
  const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("값이 정의돼 있다", () => {
    expect(CSS).toMatch(/--money-in-text:\s*#047857/i);
  });

  it("@theme 에 노출돼 있다 — 빠지면 유틸이 조용히 죽는다", () => {
    // Tailwind v4 는 @theme 에 없는 커스텀 프로퍼티로 유틸을 만들지 않는다.
    // 노출 누락은 빌드가 아니라 화면에서만 드러나므로 여기서 고정한다.
    expect(CSS).toContain("--color-money-in-text: var(--money-in-text)");
  });

  it("--status-success 를 var() 로 참조하지 않는다 — 값이 같아도 축이 다르다", () => {
    // "성공색 조정" 커밋이 자금색을 함께 끌고 가면 안 된다.
    expect(CSS).not.toMatch(/--money-in-text:\s*var\(--status-success\)/);
  });
});
