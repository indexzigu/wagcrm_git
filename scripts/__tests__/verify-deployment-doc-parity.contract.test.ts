import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 계약: `verify-deployment.sh` 의 **은퇴 상태·종료코드**와 거버넌스 문서의 서술이 같은 값을
 * 신고한다.
 *
 * 왜 필요한가 — 이 스크립트의 처분은 **두 문서에 나뉘어** 적힌다: `AGENTS.md` P0
 * 「No Hallucinated Verification」이 그것을 검증 도구로 **나열**했고,
 * `docs/agents/deployment.md`(P6) 「Deployment Verification」이 그 함정을 🪤 로 등재했다.
 * 같은 사실이 두 곳에 흩어져 있으면 한쪽만 걷힌다 — 그 실패가 바로 2026-08-21 실사고였고
 * (`await-promotion.sh` 레인 이관이 한 절만 갱신돼 이미 끝난 일이 재발주됐다), 그때 만든
 * 방어(`await-promotion-doc-parity.contract.test.ts`)를 여기서 그대로 재사용한다.
 *
 * 🪤 왜 문서를 grep 하지 않는가(부정 단언 금지): "문서에 이 문장이 없어야 한다"는 형태는
 * 이 레포에서 두 번 고장났다 — 금지 문자열을 **설명하는 주석이 자기 자신을 위반으로** 잡고,
 * 산문을 조금만 고쳐 써도 공허하게 통과한다. 판정은 산문이 아니라 문서에 심은 **기계 필드**
 * (HTML 주석 마커)와 스크립트 **실상태**의 대조로 한다.
 *
 * 🪤 앵커 함정: 앵커를 못 찾으면 "위반 없음"으로 **공허 통과**한다 — 파싱 실패를 먼저
 * 실패로 만들고, 아래 양성 대조군으로 그 방어가 살아 있는지 확인한다.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "verify-deployment.sh");
const DOC_PATHS = [
  path.join(REPO_ROOT, "AGENTS.md"),
  path.join(REPO_ROOT, "docs", "agents", "deployment.md"),
];

/**
 * 파일이 사라지면 조용히 통과시키지 않는다. 묘비를 지우는 것 자체는 정당한 후속 결정이지만,
 * 그때도 아래 두 문서의 마커를 함께 걷어야 하므로 **여기서 크게 넘어져야** 한다.
 */
if (!existsSync(SCRIPT_PATH)) {
  throw new Error(
    `${SCRIPT_PATH} 가 없다. 묘비를 완전히 제거했다면 AGENTS.md·docs/agents/deployment.md 의 ` +
      `verify-deployment 기계 마커와 이 계약 테스트를 같은 PR 에서 함께 걷을 것.`,
  );
}

const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const DOCS = DOC_PATHS.map((p) => readFileSync(p, "utf8"));

/**
 * 같은 사실을 신고해야 하는 절. 값이 아니라 **짝**이 계약이다 — 한 곳만 갱신하는 것이
 * 이 테스트가 막는 실패다. 절을 새로 나누면 여기에 추가한다.
 */
const REQUIRED_STATUS_SECTIONS = [
  "agents-no-hallucinated-verification",
  "deployment-verification",
] as const;

const STATUS_MARKER_RE =
  /<!--\s*contract:verify-deployment-status=([a-z]+)\s+section=([a-z-]+)\s*-->/g;
const EXIT_MARKER_RE = /<!--\s*contract:verify-deployment-exit-codes=([\d,]+)\s*-->/;

/** 스크립트가 스스로 신고하는 상태. 못 찾으면 실패다(공허 통과 금지). */
function scriptStatus(source = SCRIPT): string {
  const m = /^VERIFY_DEPLOYMENT_STATUS="([a-z]+)"/m.exec(source);
  expect(
    m,
    "verify-deployment.sh 에서 VERIFY_DEPLOYMENT_STATUS 선언을 찾지 못했다(앵커 함정 — 되살리거나 변수명을 바꿨으면 문서 마커와 이 테스트도 함께 고칠 것)",
  ).not.toBeNull();
  return m![1];
}

/**
 * 스크립트가 **실제로 낼 수 있는** 종료코드. 헤더 주석의 자기신고가 아니라 코드에서 뽑는다
 * — 주석은 낡을 수 있고, 낡은 주석을 근거로 삼으면 계약이 자기 자신을 검증하게 된다.
 * 전체 주석 줄은 걷어낸다(설명문의 "exit 0" 언급을 실제 방출로 세지 않기 위함 — 이 파일의
 * 헤더가 실제로 그 문자열을 인용한다).
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
    "verify-deployment.sh 에서 exit 문을 하나도 찾지 못했다(앵커 함정 — 파싱이 고장난 것이지 종료코드가 없는 것이 아니다)",
  ).toBeGreaterThan(0);
  return [...codes].sort((a, b) => a - b);
}

/** 문서가 신고한 상태 마커 목록. `절 → 값`(두 문서를 합쳐서 본다). */
function docStatusMarkers(docs: string[] = DOCS): Map<string, string> {
  const found = new Map<string, string>();
  for (const doc of docs) {
    for (const m of doc.matchAll(STATUS_MARKER_RE)) found.set(m[2], m[1]);
  }
  return found;
}

describe("verify-deployment.sh ↔ 거버넌스 문서 정합 계약", () => {
  it("스크립트는 은퇴 상태를 스스로 신고한다", () => {
    expect(scriptStatus()).toBe("retired");
  });

  it("같은 사실을 적은 **모든 절**이 스크립트와 같은 상태를 신고한다", () => {
    const status = scriptStatus();
    const markers = docStatusMarkers();

    // ① 절이 하나도 빠지지 않았는가 — 마커를 지워서 실패를 없애는 우회를 막는다.
    expect(
      [...markers.keys()].sort(),
      "AGENTS.md·deployment.md 에서 verify-deployment 상태 마커가 빠진 절이 있다(마커 삭제로 실패를 없애지 말 것 — 그러면 '한쪽만 걷힌 문서' 실패가 그대로 재발한다)",
    ).toEqual([...REQUIRED_STATUS_SECTIONS].sort());

    // ② 두 곳이 서로, 그리고 스크립트와 같은 말을 하는가.
    for (const section of REQUIRED_STATUS_SECTIONS) {
      expect(
        markers.get(section),
        `「${section}」 절이 신고한 상태가 스크립트 실상태(${status})와 다르다 — 한 곳만 갱신했을 때 나는 실패다`,
      ).toBe(status);
    }
  });

  it("문서가 신고한 종료코드 집합이 스크립트가 실제로 내는 집합과 같다", () => {
    const m = EXIT_MARKER_RE.exec(DOCS.join("\n"));
    expect(m, "deployment.md 에서 종료코드 마커를 찾지 못했다(앵커 함정)").not.toBeNull();
    const documented = m![1].split(",").map(Number).sort((a, b) => a - b);
    expect(documented).toEqual(scriptExitCodes());
  });

  it("⛔ 성공(0)으로 끝나는 경로가 없다 — 묘비의 유일한 절대 계약", () => {
    // 이 스크립트의 결함은 "틀린 근거로 초록을 준다"였다. 되살리려는 어떤 수정도
    // 0 을 내는 순간 P0 성공 오보고가 다시 가능해진다.
    expect(scriptExitCodes()).not.toContain(0);
  });

  it("실행하면 실패하고 대체 경로를 알려준다(행위 — 소스 스캔이 아니다)", () => {
    let status: number | undefined;
    let stderr = "";
    try {
      execFileSync("bash", [SCRIPT_PATH], { encoding: "utf8", stdio: "pipe" });
      status = 0;
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      status = e.status;
      stderr = e.stderr ?? "";
    }
    expect(status, "묘비가 0 을 냈다 — 호출자가 '배포 검증 성공'으로 읽는다").not.toBe(0);
    expect(
      stderr,
      "실패만 하고 대체 경로를 알려주지 않으면 호출자가 gh api 한 줄을 손으로 다시 짠다",
    ).toContain("await-promotion.sh");
  });

  it("양성 대조군 — 앵커가 사라지면 공허 통과가 아니라 실패한다", () => {
    // 이 방어가 죽으면 위 계약들이 전부 조용히 초록이 된다(이 레포의 반복 실패 모드).
    expect(() => scriptStatus("상태 선언이 없는 스크립트")).toThrow();
    expect(() => scriptExitCodes("# exit 1 은 주석이라 세지 않는다")).toThrow();
    expect(docStatusMarkers(["마커가 없는 문서"]).size).toBe(0);
  });
});
