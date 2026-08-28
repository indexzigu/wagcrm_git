import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 판정 사유 문구의 **UI 카피 계약** — em-dash(—) 금지.
 *
 * 이 문자열들은 오래 DB(`SystemTaskLog.details`)에만 있었으나, 시스템 레이더의
 * 「확인 필요」 섹션과 세무 처리 보드 다이얼로그가 **그대로 화면에 렌더한다**
 * (`tax-filing-dialog.test.tsx` 의 `screen.getByText` 가 실렌더를 잡는다). 그래서
 * 로그 문자열이 아니라 UI 카피이고, 하네스 스타일 규약(styleseed mechanical check 1)
 * 의 em-dash 금지가 예외 없이 적용된다.
 *
 * ⛔ **코드 주석은 대상이 아니다** — 이 레포의 주석은 em-dash 를 대량으로 쓰고, 그건
 * 사람이 읽는 설계 문서지 화면 카피가 아니다. 그래서 아래 추출기는 주석을 먼저 지운다.
 *
 * 🪤 **양성 대조군을 반드시 함께 둔다.** 이 레포에는 정규식이 아무것도 매치하지 못해
 * 루프가 한 번도 안 돌고 늘 초록이던 죽은 소스 스캔 테스트가 실제로 있었다
 * (`issuance-confirm.contract.test.ts` 의 `[op.field]` 사례). 그래서 ①실제로 문구가
 * 추출되는가 ②em-dash 가 섞이면 정말로 잡히는가 를 각각 단언한다.
 */

const HERE = __dirname;

/**
 * 화면에 나가는 문구를 만드는 모듈과, 각 모듈의 **양성 프로브**.
 *
 * 프로브를 파일마다 따로 두는 이유: 종전에는 두 판정 모듈이 공유하는 문구 하나
 * (`작성일자를 읽지 못했습니다.`)를 전 파일에 똑같이 요구했는데, 그건 그 두 모듈의 우연한
 * 공통점이지 계약이 아니다. 새 모듈(`receipt-similarity.ts` — 필드명이 `detail`)을 넣는
 * 순간 그 단언이 통째로 틀렸고, **스캔이 실제로 도는지**를 확인한다는 원래 목적과도 무관해진다.
 */
const SCANNED = [
  { file: "issuance-match.ts", minMessages: 10, probe: "작성일자를 읽지 못했습니다." },
  { file: "receipt-match.ts", minMessages: 10, probe: "작성일자를 읽지 못했습니다." },
  { file: "receipt-similarity.ts", minMessages: 5, probe: "작성일자를 읽지 못해 대조 불가" },
] as const;

/** 주석을 지운다 — 주석의 em-dash 는 금지 대상이 아니다. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 화면에 나가는 문구를 뽑는다(줄바꿈 뒤에 오는 형태 포함).
 *
 * `message:`(판정 사유)와 `detail:`(유사도 신호 근거) 둘 다 본다 — 이름은 다르지만 오너가
 * 같은 카드에서 나란히 읽는 카피라 규약이 갈릴 이유가 없다.
 */
function extractMessages(source: string): string[] {
  const found: string[] = [];
  const re = /(?:message|detail):\s*(["`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(source))) !== null) found.push(m[2]);
  return found;
}

describe("판정 사유 문구는 em-dash 를 쓰지 않는다 (소스 스캔)", () => {
  const byFile = new Map(
    SCANNED.map((entry) => [entry.file, extractMessages(readFileSync(join(HERE, entry.file), "utf8"))]),
  );

  it("양성 대조군 — 추출기가 실제로 문구를 뽑고 있다", () => {
    for (const entry of SCANNED) {
      const messages = byFile.get(entry.file) ?? [];
      // 매치 0건이면 아래 금지 단언이 공회전한다(이 파일 헤더의 죽은 스캔 사례).
      expect(messages.length, `${entry.file} 에서 문구를 하나도 못 뽑았다`).toBeGreaterThan(
        entry.minMessages,
      );
      // 반드시 존재하는 문구 하나를 지목해 "정말 그 파일을 읽었는가"를 못박는다.
      expect(messages.some((message) => message.includes(entry.probe)), entry.file).toBe(true);
    }
  });

  it("양성 대조군 — em-dash 가 섞이면 추출기가 정말로 잡는다", () => {
    const mutated = extractMessages('const x = { message: "금액이 다릅니다 — 계산서 1원." };');
    expect(mutated).toEqual(["금액이 다릅니다 — 계산서 1원."]);
    expect(mutated[0]).toMatch(/—/);
  });

  it("음성 대조군 — 주석의 em-dash 는 잡지 않는다", () => {
    expect(extractMessages("// 방향 판정 — 가장 먼저 끝낸다.\n/** 합계 — 한 장이라도 */")).toEqual([]);
  });

  for (const { file } of SCANNED) {
    it(`${file} 의 사유 문구에 em-dash 가 없다`, () => {
      const offenders = (byFile.get(file) ?? []).filter((message) => message.includes("—"));
      // 문장 연결부는 마침표나 쉼표로 쓴다(의미는 그대로, 구두점만 바꾼다).
      expect(offenders).toEqual([]);
    });
  }
});
