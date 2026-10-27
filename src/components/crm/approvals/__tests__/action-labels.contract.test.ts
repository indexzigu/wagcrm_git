/**
 * ACTION_LABELS × WRITE_TOOL_NAMES 짝 고정 계약.
 *
 * 기안 카드는 `payload.action` 을 한글 라벨로 바꿔 배지에 적고, 모르는 action 은
 * **원문을 그대로** 보여준다(조용히 빈 칸이 되는 것보다 낫다는 판단). 그 폴백이
 * 부작용을 하나 낳는다 — 도구를 새로 붙이고 라벨을 잊으면 화면에는 아무 오류 없이
 * `create_partner` 같은 영문 식별자가 뜬다. 타입도 테스트도 그 자리를 못 잡는다
 * (`Record<string, string>` 의 조회는 어떤 키로도 성립한다).
 *
 * 실제로 그렇게 두 개가 빠져 있었다(`create_partner` · `create_deal`, 2026-09-23).
 * 그래서 **레지스트리가 라벨 표의 상한**이라는 사실을 여기 못박는다.
 *
 * [캘린더수집] 상한을 봇 도구 목록(`WRITE_TOOL_NAMES`)에서 **실행기 화이트리스트(`WRITE_ACTIONS`)** 로 넓혔다.
 * 결재함에 기안을 올리는 것은 봇만이 아니다 — 캘린더 수집이 올리는 `create_campaign_round` 는 봇 도구가 아니라
 * 실행기에만 있는 액션이고, 종전 상한으로는 그 라벨을 둘 수 없어 배지에 영문 식별자가 뜰 자리였다. 보호 의도
 * (낡은 라벨이 조용히 남지 않는다)는 그대로다 — 실행기에서 빠진 액션의 라벨은 여전히 실패한다. 오히려 하한을
 * 실행기 전체로 올려, 봇 도구가 아닌 액션도 라벨 없이 결재함에 뜨지 못하게 했다.
 */
import { describe, expect, it } from "vitest";
import { WRITE_TOOL_NAMES } from "@/lib/agent/tools/types";
import { WRITE_ACTIONS } from "@/lib/agent/write-actions";
import { ACTION_LABELS } from "@/lib/agent/action-labels";

describe("ACTION_LABELS 계약", () => {
  it("모든 WRITE 도구에 한글 라벨이 있다", () => {
    const missing = [...WRITE_TOOL_NAMES].filter((name) => !ACTION_LABELS[name]);
    expect(missing).toEqual([]);
  });

  it("결재함에 기안될 수 있는 모든 실행기 액션에 한글 라벨이 있다(봇 도구가 아닌 것 포함)", () => {
    const missing = Object.keys(WRITE_ACTIONS).filter((name) => !ACTION_LABELS[name]);
    expect(missing).toEqual([]);
  });

  it("라벨 표에 실행기 액션이 아닌 키를 두지 않는다 — 낡은 라벨은 조용히 남는다", () => {
    const orphans = Object.keys(ACTION_LABELS).filter((key) => !Object.hasOwn(WRITE_ACTIONS, key));
    expect(orphans).toEqual([]);
  });

  it("라벨은 빈 문자열이 아니다", () => {
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      expect(label.trim().length, action).toBeGreaterThan(0);
    }
  });
});
