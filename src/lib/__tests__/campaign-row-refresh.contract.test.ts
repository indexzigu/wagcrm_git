/**
 * 캠페인 행 재조회 SSOT 의 **소스 계약** (T-099·T-101).
 *
 * 행위는 `campaign-row-refresh.test.ts` 가 본다. 여기는 「사본이 다시 생기는 것」과
 * 「롤업을 비우는 새 경로가 생기는 것」을 소스에서 막는다 — 단위 테스트로는 **미래의 새
 * 호출부**를 못 막기 때문이다.
 *
 * 🪤 이 레포가 소스 스캔에서 반복해 밟은 함정 셋을 여기서도 그대로 피한다:
 *  ① **주석을 걷어내고 센다** — 설명문이 금지 문자열을 인용해 계약이 자기 주석에 걸린다.
 *  ② **이름 등장이 아니라 실제 사용을 본다** — 주석에서만 언급해도 통과하면 소비처
 *     단언이 의미를 잃는다(실제로 정산 패널이 이 상수를 주석에서만 언급한다).
 *  ③ **금지 문자열을 손으로 적지 않는다** — 상수에서 파생시킨다. 손복사본이면 상수를
 *     리워딩하는 순간 가드가 옛 문구를 찾으며 영원히 초록이다(stale-green).
 * 그리고 「없음」 단언에는 **양성 프로브**를 짝지운다 — 스캐너가 고장 나도 초록이기 때문이다.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIST_REFRESH_FAILED_MESSAGE } from "../campaign-row-refresh";

const root = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** 블록·줄 주석을 걷어낸다(함정 ①). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    // 🪤 `://` 는 지킨다 — 가드 없이 자르면 URL 이 든 줄이 통째로 잘려 그 줄의 위반이
    // **사라진다**(레포의 mail-config 계약이 같은 이유로 같은 가드를 둔다).
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * 목록(보드) 행이 못 따라왔다고 말하는 표면들.
 * ⚠️ **손으로 적은 목록이다** — 같은 말을 하는 표면을 새로 만들면 여기 등재할 것.
 * 전수 스캔을 안 쓰는 이유는 "새로고침" 같은 어절이 다른 질문에도 정당하게 쓰이기 때문이다.
 */
const LIST_SURFACES = [
  "src/components/crm/campaign-group-section.tsx",
  "src/components/crm/crm-dashboard.tsx",
];

/**
 * 상수에서 파생한 금지 어절(함정 ③) — 리워딩하면 이 needle 도 함께 바뀐다.
 *
 * 🪤 **접두가 아니라 꼬리에서 딴다.** 원 결함은 *"동사만 다른 문장"* 이었으므로 앞머리
 * (`묶기는`/`제외는`/`작업은`)는 사본마다 다르다 — 접두 12자로 잘랐더니 정작 옛 사본
 * 둘을 **하나도 못 잡았다**(하드코딩 needle 보다 약해졌다). 첫 어절을 떼면 사본들이
 * 공유하던 절만 남는다. 그 성질은 아래 「옛 사본을 실제로 잡는다」가 고정한다.
 */
const HANDCOPY_NEEDLE = LIST_REFRESH_FAILED_MESSAGE.slice(
  LIST_REFRESH_FAILED_MESSAGE.indexOf(" ") + 1,
);

/**
 * 이 가드가 생기기 전 실제로 손으로 적혀 있던 문장들(origin/main 실측).
 * ⚠️ **상수를 정당하게 리워딩하면 아래 단언이 빨강이 된다** — 그때 고칠 것은 needle 파생이
 * 아니라 이 픽스처다. 옛 사본은 역사적 사실이므로 지우지 말고, 새 문구가 이 둘을 더 이상
 * 포함하지 않는 것이 의도라면 그 사실을 여기 한 줄로 적고 픽스처를 새 문구 기준으로 옮긴다.
 */
const HISTORICAL_HANDCOPIES = [
  "묶기는 끝났지만 목록 갱신이 일부 실패했습니다. 새로고침해 주세요.",
  "제외는 끝났지만 목록 갱신이 일부 실패했습니다. 새로고침해 주세요.",
];

describe("목록 실패 문구는 상수 한 곳이 소유한다", () => {
  it("needle 이 옛 사본을 실제로 잡는다 — 좁아지면 여기서 먼저 깨진다", () => {
    // ⛔ `expect(상수).toContain(needle)` 로 되돌리지 말 것 — slice 정의상 항상 참이라
    // 아무것도 지키지 않는다. 지켜야 하는 성질은 "이 needle 이면 그 사본들을 잡았다"다.
    for (const copy of HISTORICAL_HANDCOPIES) {
      expect(copy).toContain(HANDCOPY_NEEDLE);
    }
    expect(HANDCOPY_NEEDLE.length).toBeGreaterThan(10);
  });

  it.each(LIST_SURFACES)("%s 는 상수를 쓰고 문장을 손으로 적지 않는다", (rel) => {
    const code = stripComments(read(rel));
    // 함정 ② — 주석을 걷어낸 뒤에도 남아야 「실제로 쓴다」가 된다.
    expect(code).toContain("LIST_REFRESH_FAILED_MESSAGE");
    expect(code).not.toContain(HANDCOPY_NEEDLE);
  });

  it("양성 프로브 — 손으로 적은 사본을 스캐너가 실제로 잡는다", () => {
    const violating = `const x = "${LIST_REFRESH_FAILED_MESSAGE}";`;
    expect(stripComments(violating)).toContain(HANDCOPY_NEEDLE);
    // 음성 대조군 — 주석 안의 같은 문장은 위반이 아니다(함정 ①이 실제로 동작하는지).
    expect(stripComments(`// ${LIST_REFRESH_FAILED_MESSAGE}`)).not.toContain(HANDCOPY_NEEDLE);
  });
});

/**
 * 롤업을 **비울 수 있는 경로**를 등재로 묶는다 (T-101 의 남은 절반).
 *
 * `CampaignGroupRollupUpdate` 가 `null` 을 거부하지만 그 타입은 리포지토리를 **거치는**
 * 쓰기에만 걸린다 — `tx.campaignGroup.update` 를 직접 부르는 자리는 타입 좁히기가 닿지
 * 않는다. 오늘은 그 어느 곳도 기간을 쓰지 않지만, 새로 생기면 조용히 뚫린다.
 */

/**
 * `campaignGroup.update(Many)` **그 호출의 인자 안에서만** 롤업 필드를 찾는다.
 * ⛔ 고정 길이 창으로 되돌리지 말 것 — 바로 뒤 호출의 인자를 물어 오탐이 난다(실측).
 */
function rollupWritesIn(code: string): string[] {
  const hits: string[] = [];
  for (const m of code.matchAll(/campaignGroup\.update(?:Many)?\(/g)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (let i = end; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const args = code.slice(m.index!, end);
    if (/\bstartDate\s*:/.test(args)) hits.push("startDate");
    if (/\bendDate\s*:/.test(args)) hits.push("endDate");
  }
  return hits;
}

describe("그룹 기간을 쓰는 경로는 리포지토리를 거친다 (T-101)", () => {
  /**
   * 리포지토리 밖에서 CampaignGroup 을 직접 갱신하는 파일 — **전수를 소스에서 뽑아 대조**한다.
   * ⛔ `it.each` 로 손 목록만 돌리지 말 것: 새 파일이 생겨도 조용히 통과한다(초판이 그랬고
   * 실제로 `scripts/` 두 개를 빠뜨렸다). 형제 계약(`campaignGroupRollup.contract.test.ts`)이
   * 쓰는 `git grep -l` 전수 열거가 이 트랙의 선례다.
   */
  const DIRECT_GROUP_WRITERS = [
    "scripts/backfill-campaign-group-settlement-dates.ts",
    "scripts/sync-group-return-period.ts",
    "src/app/api/cron/tax-invoice-issue-confirm/route.ts",
    "src/lib/campaign-checklist.ts",
    "src/lib/google-calendar-sync.ts",
    "src/lib/settlement-flag-write.ts",
    "src/services/campaignService.ts",
    "src/services/taxInvoiceReceiptDecisionService.ts",
  ];

  it("직접 갱신 파일 목록이 소스와 일치한다 — 새 경로가 생기면 여기서 걸린다", () => {
    const found = execFileSync(
      "git",
      ["grep", "-l", "campaignGroup\\.update", "--", "src", "scripts"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f && !f.includes("__tests__") && !f.endsWith("campaignGroupRepository.ts"));
    expect(found.sort()).toEqual(DIRECT_GROUP_WRITERS);
  });

  it.each(DIRECT_GROUP_WRITERS)("%s 의 직접 갱신은 기간을 리터럴로 쓰지 않는다", (rel) => {
    // ⚠️ **이 스캔은 리터럴 형태만 본다** — `data: someVariable` 이나 동적 키
    // (`{ [field]: v }`)로 넘기면 못 본다. 등재 파일 중 리터럴 객체를 넘기는 자리는
    // 셋이고(`sync-group-return-period` · `google-calendar-sync` 둘) 거기서 기간을 쓰면
    // **지금도 잡힌다** — 나머지는 변수로 넘겨 사각이다. 방어의 본체는 **위 전수 대조**이고
    // 이건 값싼 보조선이다. ⛔ 이걸 「기간을 안 쓴다」의 증명으로 읽지 말 것.
    expect(rollupWritesIn(stripComments(read(rel)))).toEqual([]);
  });

  it("양성 프로브 — 기간을 쓰는 직접 갱신이 있으면 잡는다", () => {
    expect(
      rollupWritesIn("await tx.campaignGroup.update({ where: { id }, data: { startDate: d } });"),
    ).toEqual(["startDate"]);
    expect(
      rollupWritesIn("await tx.campaignGroup.updateMany({ data: { endDate: d } });"),
    ).toEqual(["endDate"]);
  });

  it("음성 대조군 — 인접한 다른 호출의 기간 인자를 물지 않는다", () => {
    // 🪤 초판은 호출 지점부터 고정 길이 창을 봐서, **바로 뒤 함수**(멤버 팬아웃)의
    // `startDate:` 를 그룹 갱신의 것으로 잘못 읽었다(campaignService 에서 실제로 걸렸다).
    // 그래서 창이 아니라 **그 호출의 인자 괄호**까지만 자른다.
    const code = `
      await tx.campaignGroup.updateMany({ where: { id }, data: shared });
      await fanOutMemberSchedule(gid, id, { startDate: new Date(x) }, tx);
    `;
    expect(rollupWritesIn(code)).toEqual([]);
  });
});
