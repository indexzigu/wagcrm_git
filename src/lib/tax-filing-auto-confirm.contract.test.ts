/**
 * 계약 — 「자동 확정됨」 묶음이 **조용히 비거나 조용히 줄어드는** 두 경로를 막는다.
 *
 * 둘 다 타입·유닛 테스트가 잡지 못한다. 화면은 정상적으로 렌더되고 숫자만 틀린다.
 *
 * 1. **`type` 문자열 드리프트** — 크론이 쓰는 `ActivityLog.type` 과 다이얼로그가 조회하는
 *    문자열이 갈리면 화면이 **영구히 0건**이 된다(오류도, 경고도 없다).
 * 2. **캠페인 단독 조회로의 회귀** — 보드 캠페인의 로그만 읽으면, 확정 후 그룹에서
 *    분리돼 다른 상태로 옮겨간 멤버의 로그가 조회에서 빠져 "기계가 2건에 손댔다"가
 *    "1건"으로 보고된다. 개수 축소는 이 화면이 존재하는 이유(기계가 건드린 범위를
 *    오너에게 정직하게 보여주기)를 정면으로 훼손한다. (2026-08-09 축 분리 이전엔 이
 *    스코프가 "이 달 캠페인"이었다 — 지금은 캠페인 상태 축이다.)
 *
 * 소스 스캔인 이유: 두 결함 모두 **DB 상태와 시간이 얽힌 조합**에서만 드러나므로 행위
 * 테스트로 재현하려면 Prisma·그룹 편집 흐름 전체를 목킹해야 한다. 여기서는 "그 방어가
 * 코드에 존재하는가"만 기계로 고정한다.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_CONFIRM_SEED_LOOKBACK_DAYS,
  AUTO_CONFIRM_SEED_LOOKBACK_LABEL,
  TAX_INVOICE_AUTO_CONFIRM_TOLERATED_TYPE,
  TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX,
} from "./tax-filing-auto-confirm";

const ROOT = join(__dirname, "..", "..");
const CRON = join(ROOT, "src/app/api/cron/tax-invoice-issue-confirm/route.ts");
const BOARD_ROUTE = join(ROOT, "src/app/api/settlement/tax-filing-board/route.ts");

function read(path: string): string {
  const source = readFileSync(path, "utf8");
  // 양성 대조군 — 경로가 틀렸거나 파일이 비면 아래 단언들이 전부 "위반 없음"으로 통과한다.
  expect(source.length).toBeGreaterThan(500);
  return source;
}

describe("자동 확정 로그의 type 문자열", () => {
  it("크론이 쓰는 type 은 전부 이 접두사로 시작한다 — 하나라도 벗어나면 화면에서 사라진다", () => {
    const source = read(CRON);

    // ⚠️ 크론 파일은 **다른 세션 소유**다 — 이 계약은 그 파일을 고치지 않고 **읽기만**
    //    한다. 형태를 강제하면 그쪽 변경과 충돌한다.
    //
    // 🪤 초판은 `type: "리터럴"` 한 줄만 봤다가 #304 가 그 자리를 여러 줄 삼항
    //    (`type: toleratedDelta ? "…_TOLERATED" : "…"`)으로 바꾸자 **0건**을 집었다.
    //    양성 대조군이 없었으면 "위반 없음"으로 초록불이 켜졌을 것이다. 그래서 형태를
    //    묻지 않고 **`activityLog.create` 블록 안의 문자열 리터럴 전부**를 본다.
    const createBlock = source.slice(source.indexOf("activityLog.create"));
    expect(createBlock.length).toBeGreaterThan(100); // 양성 대조군 ②: 블록을 못 찾으면 실패
    const autoConfirmTypes = [...createBlock.matchAll(/"([A-Z_]*AUTO_CONFIRM[A-Z_]*)"/g)].map(
      (m) => m[1],
    );

    // 양성 대조군 — 하나도 못 찾았다면 정규식이 낡은 것이지 "위반 없음"이 아니다.
    expect(autoConfirmTypes.length).toBeGreaterThan(0);
    for (const type of autoConfirmTypes) {
      expect(type.startsWith(TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX)).toBe(true);
    }
  });

  it("보드 라우트는 정확 일치가 아니라 **접두사**로 조회한다 — 흡수 확정 건이 사라지지 않게", () => {
    const source = read(BOARD_ROUTE);

    expect(source).toContain("TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX");
    expect(source).toMatch(/type:\s*\{\s*startsWith:/);
    // 정확 일치 조회로 되돌아가면 `…_TOLERATED` 건이 화면에서 통째로 빠진다.
    expect(source).not.toMatch(/type:\s*TAX_INVOICE_AUTO_CONFIRM_TYPE\b/);
  });

  it("접두사 값 자체는 `@@index([type])` 로 뽑히는 그 문자열이다", () => {
    expect(TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX).toBe("TAX_INVOICE_AUTO_CONFIRM");
    expect(TAX_INVOICE_AUTO_CONFIRM_TOLERATED_TYPE.startsWith(TAX_INVOICE_AUTO_CONFIRM_TYPE_PREFIX)).toBe(
      true,
    );
  });

  it("⛔ 흡수 여부를 `content` 문장 파싱으로 세지 않는다 — 문구를 다듬으면 조용히 0건이 된다", () => {
    const source = read(BOARD_ROUTE) + read(join(ROOT, "src/lib/tax-filing-auto-confirm.ts"));

    // 「허용오차」·「흡수」 같은 한국어 낱말로 content 를 검사하는 코드가 들어오는 것을 막는다.
    expect(source).not.toMatch(/content[^\n]{0,40}(includes|match|indexOf)[^\n]{0,20}허용오차/);
    expect(source).not.toMatch(/content[^\n]{0,40}(includes|match|indexOf)[^\n]{0,20}흡수/);
  });
});

describe("자동 확정 조회 범위", () => {
  it("확정 1건의 멤버를 op 키(content)로 다시 모은다 — 캠페인 단독 조회로 되돌리지 않는다", () => {
    const source = read(BOARD_ROUTE);

    // 2단계 조회의 형태: op 키를 모아 캠페인 제한 없이 재조회한다.
    expect(source).toMatch(/content:\s*\{\s*in:/);
    // 1단계(보드가 다루는 캠페인 — 정산 진행 + 정산 완료 상태, 월 무관)도 여전히
    // 있어야 한다 — 없으면 그 스코프가 통째로 사라진다. 이름을 핀으로 박는다
    // (느슨한 `entityId:\s*\{\s*in:` 만 보면 아무 변수나 통과해 계약이 죽는다) —
    // 2026-08-09 축 분리로 `campaignIdsInMonth` → `boardCampaignIds` 로 개명됐다.
    expect(source).toMatch(/entityId:\s*\{\s*in:\s*boardCampaignIds/);
  });

  /**
   * 3번째 결함 — **기간 컷 소실로 인한 영구 누적**.
   *
   * 2026-08-09 축 분리로 seed 조회 스코프가 「이 달 캠페인」에서 「보드 캠페인 전체」로
   * 넓어졌는데, 그 집합은 단조 증가한다(정산 완료 캠페인은 빠지지 않는다). 기간 컷이
   * 없으면 「자동 확정됨 N건」이 전 기간 누적치가 되어 커지기만 하고, 오너는 그 줄을
   * 읽기를 그만둔다 — 설계가 `pendingCount` 에서 명시적으로 막은 실패 형태다.
   *
   * 동시에 **2단계에는 컷을 걸면 안 된다** — 그쪽은 「한 확정에 걸린 멤버 전원을
   * 복원한다」가 목적이라, 좁히면 위 2번 결함(개수 축소)이 그대로 되살아난다. 두 요구가
   * 서로 반대 방향이라 한쪽만 보면 다른 쪽을 깨기 쉬워 여기서 짝으로 고정한다.
   */
  it("seed 조회에는 기간 컷이 있고, 멤버 복원(2단계) 조회에는 없다 — 두 요구는 반대 방향이다", () => {
    const source = read(BOARD_ROUTE);

    const seedStart = source.indexOf("const seedLogs");
    const memberStart = source.indexOf("const memberLogs");
    const memberEnd = source.indexOf("buildAutoConfirmedEntries(");
    // 양성 대조군 — 앵커가 하나라도 밀리면 아래 단언이 "위반 없음"으로 통과한다.
    expect(seedStart).toBeGreaterThan(0);
    expect(memberStart).toBeGreaterThan(seedStart);
    expect(memberEnd).toBeGreaterThan(memberStart);

    const seedBlock = source.slice(seedStart, memberStart);
    const memberBlock = source.slice(memberStart, memberEnd);

    // ① seed 는 createdAt 하한을 건다.
    expect(seedBlock).toMatch(/createdAt:\s*\{\s*gte:\s*autoConfirmSince/);
    // ② 그 하한값은 상수에서 계산된다 — 라우트에 날짜·일수를 직접 박으면 화면 문구와
    //    갈려서 "최근 90일"이라고 써 놓고 다른 창을 조회하는 상태가 된다.
    expect(source).toMatch(
      /const autoConfirmSince[\s\S]{0,200}AUTO_CONFIRM_SEED_LOOKBACK_DAYS/,
    );
    // ③ 2단계는 기간으로 좁히지 않는다.
    expect(memberBlock).not.toMatch(/createdAt/);
    // ④ 2단계의 op 키 재조회 형태는 그대로 남아 있어야 한다.
    expect(memberBlock).toMatch(/content:\s*\{\s*in:/);
  });

  it("화면 문구의 기간과 조회 창이 같은 상수에서 나온다 — 갈리면 화면이 거짓을 말한다", () => {
    expect(AUTO_CONFIRM_SEED_LOOKBACK_DAYS).toBe(90);
    expect(AUTO_CONFIRM_SEED_LOOKBACK_LABEL).toBe(`최근 ${AUTO_CONFIRM_SEED_LOOKBACK_DAYS}일`);

    // 다이얼로그는 라벨을 이 상수에서 읽는다(문자열을 다시 적지 않는다).
    const dialog = read(join(ROOT, "src/components/crm/tax-filing-dialog.tsx"));
    expect(dialog).toContain("AUTO_CONFIRM_SEED_LOOKBACK_LABEL");
  });
});
