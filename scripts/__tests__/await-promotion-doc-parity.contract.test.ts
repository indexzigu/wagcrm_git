import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 계약: `await-promotion.sh` 의 **판정 레인·종료코드**와 P6 문서의 서술이 같은 값을 신고한다.
 *
 * 왜 필요한가 — 실사고 2026-08-21. #418 이 기본 판정 레인을 `release` → 셀프호스트 마커로
 * 옮겼는데, `docs/agents/deployment.md` 는 같은 사실을 **두 절**에 나눠 적고 있었다.
 * 문서 이관 패스(#419)가 「배포완료 자동통지」 항목만 갱신하고 「Deployment Verification」
 * 절을 놓쳐, 그 절은 착지 뒤에도 *"그 스크립트는 여전히 release 레인 … 상시 위음성"* 이라고
 * 말했다. 그 조문만 읽은 세션이 **이미 끝난 이관을 다시 발주받았다.**
 *
 * 즉 결함은 "한 문장이 낡았다"가 아니라 **같은 사실이 두 곳에 있는데 묶여 있지 않다**였다.
 * 그래서 이 계약은 두 절 **모두** 값을 신고하게 만든다 — 한쪽만 고치면 깨진다.
 *
 * 🪤 왜 문서를 grep 하지 않는가(부정 단언 금지): "문서에 이 문장이 없어야 한다"는 형태는
 * 이 레포에서 두 번 고장났다 — 금지 문자열을 **설명하는 주석이 자기 자신을 위반으로** 잡고,
 * 산문을 조금만 고쳐 써도 공허하게 통과한다. 판정은 산문이 아니라 문서에 심은 **기계 필드**
 * (HTML 주석 마커)와 스크립트 실값의 대조로 한다. 마커는 렌더에 보이지 않으므로 서술을
 * 자유롭게 다시 써도 계약은 살아 있다. 선례: cron-staleness-threshold-parity(문턱 정합).
 *
 * 🪤 앵커 함정: 앵커를 못 찾으면 "위반 없음"으로 **공허 통과**한다 — 파싱 실패를 먼저
 * 실패로 만들고, 아래 양성 대조군으로 그 방어가 살아 있는지 확인한다.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "await-promotion.sh");
const DOC_PATH = path.join(REPO_ROOT, "docs", "agents", "deployment.md");

const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const DOC = readFileSync(DOC_PATH, "utf8");

/**
 * 같은 사실을 신고해야 하는 문서 절. 값이 아니라 **짝**이 계약이다 — 한 절만 갱신하는
 * 것이 바로 이 테스트가 막는 실패다. 절을 새로 나누면 여기에 추가한다.
 */
const REQUIRED_LANE_SECTIONS = ["deployment-verification", "await-notify"] as const;

const LANE_MARKER_RE =
  /<!--\s*contract:await-promotion-default-lane=([a-z]+)\s+section=([a-z-]+)\s*-->/g;
const EXIT_MARKER_RE = /<!--\s*contract:await-promotion-exit-codes=([\d,]+)\s*-->/;

/** 스크립트가 **오버라이드 없이** 쓰는 기본 레인. 못 찾으면 실패다(공허 통과 금지). */
function scriptDefaultLane(source = SCRIPT): string {
  const m = /^LANE_MODE="([a-z]+)"/m.exec(source);
  expect(
    m,
    "await-promotion.sh 에서 LANE_MODE 기본값을 찾지 못했다(앵커 함정 — 변수명을 바꿨으면 이 테스트도 함께 고칠 것)",
  ).not.toBeNull();
  return m![1];
}

/**
 * 스크립트가 **실제로 낼 수 있는** 종료코드. 헤더 주석의 자기신고가 아니라 코드에서 뽑는다
 * — 주석은 낡을 수 있고, 낡은 주석을 근거로 삼으면 계약이 자기 자신을 검증하게 된다.
 * 전체 주석 줄은 걷어낸다(설명문의 "exit 3" 언급을 실제 방출로 세지 않기 위함).
 */
function scriptExitCodes(source = SCRIPT): number[] {
  const codeOnly = source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const codes = new Set<number>();
  for (const m of codeOnly.matchAll(/\bexit\s+(\d+)\b/g)) codes.add(Number(m[1]));
  expect(
    codes.size,
    "await-promotion.sh 에서 exit 문을 하나도 찾지 못했다(앵커 함정 — 파싱이 고장난 것이지 종료코드가 없는 것이 아니다)",
  ).toBeGreaterThan(0);
  return [...codes].sort((a, b) => a - b);
}

/** 문서가 신고한 레인 마커 목록. `절 → 값`. */
function docLaneMarkers(doc = DOC): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of doc.matchAll(LANE_MARKER_RE)) found.set(m[2], m[1]);
  return found;
}

describe("await-promotion.sh ↔ P6 문서 정합 계약", () => {
  it("기본 판정 레인은 셀프호스트 마커다 (#418)", () => {
    // 이 값이 바뀌면 문서 전 절을 재검토해야 한다 — 아래 짝 계약이 그것을 강제한다.
    expect(scriptDefaultLane()).toBe("selfhost");
  });

  it("같은 사실을 적은 **모든 절**이 스크립트와 같은 레인을 신고한다", () => {
    const lane = scriptDefaultLane();
    const markers = docLaneMarkers();

    // ① 절이 하나도 빠지지 않았는가 — 마커를 지워서 실패를 없애는 우회를 막는다.
    expect(
      [...markers.keys()].sort(),
      "deployment.md 에서 레인 마커가 빠진 절이 있다(마커 삭제로 실패를 없애지 말 것 — 그러면 2026-08-21 실사고가 그대로 재발한다)",
    ).toEqual([...REQUIRED_LANE_SECTIONS].sort());

    // ② 두 절이 서로, 그리고 스크립트와 같은 말을 하는가 — 이게 실사고의 정확한 지점이다.
    for (const section of REQUIRED_LANE_SECTIONS) {
      expect(
        markers.get(section),
        `deployment.md 「${section}」 절이 신고한 레인이 스크립트 기본값(${lane})과 다르다 — 한 절만 갱신했을 때 나는 실패다`,
      ).toBe(lane);
    }
  });

  it("문서가 신고한 종료코드 집합이 스크립트가 실제로 내는 집합과 같다", () => {
    const m = EXIT_MARKER_RE.exec(DOC);
    expect(
      m,
      "deployment.md 에서 종료코드 마커를 찾지 못했다(앵커 함정)",
    ).not.toBeNull();
    const documented = m![1].split(",").map(Number).sort((a, b) => a - b);

    // #418 이 5(판정 불가)를 신설했을 때 낡은 절은 그것을 몰랐다. 새 코드가 늘거나
    // 기존 코드가 사라지면 문서를 함께 고치도록 강제한다.
    expect(documented).toEqual(scriptExitCodes());
  });

  it("양성 대조군 — 앵커가 사라지면 공허 통과가 아니라 실패한다", () => {
    // 이 방어가 죽으면 위 세 계약이 전부 조용히 초록이 된다(이 레포의 반복 실패 모드).
    expect(() => scriptDefaultLane("레인 선언이 없는 스크립트")).toThrow();
    expect(() => scriptExitCodes("# exit 3 은 주석이라 세지 않는다")).toThrow();
    expect(docLaneMarkers("마커가 없는 문서").size).toBe(0);
  });
});
