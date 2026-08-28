// 대시보드 페이로드의 정산 신호 재유입 계약 테스트 (2026-07-31, PR #196 잔여 위험 1 후속).
//
// 배경: `getDesktopDashboardData` 의 exceptions.pendingDeposits ·
// exceptions.settlementMismatches · quality 블록은 정산 여부를 **멤버 행**의
// isDepositReceived/isPayoutCompleted 로 판정했다. 캠페인 그룹(CG-1)에서 그 플래그의
// SoT 는 **그룹 스칼라**(CampaignGroup.isDepositReceived 등)이고 멤버 행은 낡을 수 있어,
// ①그룹 멤버 수만큼 부풀려 세고 ②이미 입금된 그룹을 미입금으로 오판했다. 렌더 소비처가
// 0건이라 무해했지만 "이미 계산돼 있으니"라며 화면에 이어붙이면 즉시 재발하는 구조였다.
//
// 이 계약은 그 재유입만 좁게 막는다. **정산 플래그를 멤버 행으로 읽는 것 자체는 금지가
// 아니다** — 정산 화면 배지·칸반·딜 상세처럼 행 단위가 정답인 표면이 오너 확정으로 다수
// 존재한다(레포 전역 39파일). 따라서 스캔 대상을 이 대시보드 집계 페이로드 한 파일로 좁힌다.
//
// 집계 표면에서 정산 신호가 필요하면 computeDataIntegrityIssues 의 SETTLEMENT_INCOMPLETE
// (그룹 플래그 dual-read + 그룹당 1건 접기, src/lib/data-integrity.ts)를 쓴다 —
// 이 페이로드의 dataIntegrityIssues 로 이미 나가고 있다.
//
// 선례: instagram-scrape-callers.contract.test.ts(화이트리스트로 리뷰 지점 강제).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = "src/lib/desktop-dashboard.ts";
const source = readFileSync(join(process.cwd(), SOURCE_PATH), "utf8");

/** 반환 리터럴에서 `<key>: {` 블록의 본문을 중괄호 균형으로 잘라낸다. */
function extractObjectLiteral(key: string): string | null {
  const marker = `\n    ${key}: {`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  const bodyStart = source.indexOf("{", start);
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, i);
    }
  }
  return null;
}

/** 객체 리터럴 본문에서 최상위 키 이름만 뽑는다(중첩·주석 제외). */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (depth === 0 && !line.startsWith("//") && !line.startsWith("*")) {
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (match) keys.push(match[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    }
  }
  return keys;
}

describe("대시보드 페이로드 — 정산 신호는 그룹 SoT 경로로만 (CG-1)", () => {
  it("exceptions 는 영업 후속 액션 신호만 담는다 — 키 추가는 리뷰 지점이다", () => {
    const body = extractObjectLiteral("exceptions");
    expect(body, `${SOURCE_PATH} 의 exceptions 반환 리터럴을 찾지 못했다`).not.toBeNull();

    // 아웃리치 단위는 그룹 개념이 없어 행 단위가 정답이다. 여기에 정산 신호(입금 대기·
    // 정산 불일치)를 추가하면 멤버 행 플래그 판정이 되살아난다 — dataIntegrityIssues 를 쓸 것.
    expect(topLevelKeys(body!).sort()).toEqual(["overdueReminders", "pendingApprovals"]);
  });

  it("quality 블록을 되살리지 않는다 — 전량 정본 중복이었다", () => {
    // endedMissingSales: data-integrity 의 MISSING_SALES 와 술어 동일(그쪽만 그룹을 접는다)
    // settlementMismatches: 위와 같은 SoT 위반
    // missingGoals: 같은 페이로드의 goals.monthTarget/annualTarget null 여부로 파생
    expect(extractObjectLiteral("quality")).toBeNull();
  });

  it("멤버 행 정산 플래그를 술어로 쓰지 않는다 — 그룹 접기 배선의 값 전달만 허용", () => {
    // 허용: `isDepositReceived: campaign.group.isDepositReceived`(computeDataIntegrityIssues
    // 로 넘기는 값 전달) · prisma select 의 `isDepositReceived: true`.
    // 금지: `!campaign.isDepositReceived` · `=== false` 같은 **판정**.
    const predicates = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
      .filter(({ line }) =>
        /!\s*[\w.]*\.?(isDepositReceived|isPayoutCompleted)\b/.test(line) ||
        /(isDepositReceived|isPayoutCompleted)\s*(===|!==|\?)/.test(line),
      );

    expect(
      predicates.map(({ no, line }) => `${SOURCE_PATH}:${no} ${line}`),
      "집계 판정은 computeDataIntegrityIssues(그룹 dual-read)가 담당한다",
    ).toEqual([]);
  });
});
