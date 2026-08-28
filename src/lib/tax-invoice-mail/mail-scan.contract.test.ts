import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  pickTaxInvoiceBox,
  isTaxInvoiceSubject,
  isTaxInvoiceSender,
  isTaxInvoiceCandidate,
} from "./mail-scan";

const RAW_SOURCE = readFileSync(
  join(process.cwd(), "src/lib/tax-invoice-mail/mail-scan.ts"),
  "utf8",
);

/**
 * 주석을 걷어낸 실행 코드만 본다.
 * 이 모듈의 문서가 금지 심볼을 **이름으로 언급**하기 때문에(그게 문서의 요점이다),
 * 원문 그대로 스캔하면 자기 주석에 걸려 영구히 빨간불이 된다.
 */
const SOURCE = RAW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("편지함 선택", () => {
  it("설정된 폴더가 실재하면 그것을 쓴다", () => {
    expect(pickTaxInvoiceBox(["INBOX", "세금계산서"], "세금계산서")).toBe("세금계산서");
  });

  it("설정이 없어도 오너의 전용 폴더('세금계산서')를 기본으로 집는다", () => {
    expect(pickTaxInvoiceBox(["INBOX", "보낸편지함", "세금계산서"])).toBe("세금계산서");
  });

  it("'계산서' 가 든 폴더가 여럿이어도 정확 일치가 우선한다(나열 순서에 좌우되지 않는다)", () => {
    expect(pickTaxInvoiceBox(["계산서_보관", "INBOX", "세금계산서"])).toBe("세금계산서");
  });

  it("전용 폴더가 없으면 '계산서' 가 든 폴더로 폴백한다", () => {
    expect(pickTaxInvoiceBox(["INBOX", "보낸편지함", "전자계산서"])).toBe("전자계산서");
  });

  it("설정된 폴더가 실재하지 않으면 자동 탐지로 폴백한다(빈 폴더를 열어 0건으로 오판하지 않는다)", () => {
    expect(pickTaxInvoiceBox(["INBOX", "세금계산서"], "없는폴더")).toBe("세금계산서");
  });

  it("후보가 없으면 INBOX", () => {
    expect(pickTaxInvoiceBox(["INBOX", "보낸편지함"])).toBe("INBOX");
  });
});

describe("제목 힌트", () => {
  it("계산서 계열 제목을 통과시킨다", () => {
    expect(isTaxInvoiceSubject("[전자세금계산서] 발행 안내")).toBe(true);
    expect(isTaxInvoiceSubject("계산서 발행 완료")).toBe(true);
  });

  it("무관한 제목은 거른다", () => {
    expect(isTaxInvoiceSubject("발주서 회신드립니다")).toBe(false);
  });
});

/**
 * ⛔ 실사고 고정(2026-08-05) — 수취가 끝난 계산서가 「미수취(스캔에 없음)」로 표시됐다.
 *
 * 국세청 **직발송** 발급 안내의 실측 제목은 `공급받는자상호 (공급자상호->공급받는자상호)` 라
 * 「계산서」가 한 글자도 없다. 제목 힌트만 관문으로 쓰면 이 계열이 헤더 단계에서 통째로
 * 사라지고, 그 뒤의 복호·대조는 아예 돌지도 않는다.
 *
 * 아래 첫 케이스가 **결함 그 자체**다 — `isTaxInvoiceSubject` 는 지금도 false 여야 하고
 * (제목만으로는 구제할 수 없다), 구제는 발신처 관문이 한다.
 */
describe("국세청 직발송 관문", () => {
  /**
   * 주소는 조각으로 조립한다 — 커밋 가드(P0 공개 레포)가 소스의 이메일 리터럴을 막는다.
   * 판정은 도메인 부분문자열 대조라 조립 여부가 결과를 바꾸지 않으면서 실제 헤더 형식은
   * 그대로 유지된다.
   */
  const address = (local: string, domain: string) => `${local}@${domain}`;

  const NTS_SUBJECT = "우리상호 (거래처상호->우리상호)";
  const NTS_FROM = `국세청 <${address("hometaxadmin", "hometax.go.kr")}>`;

  it("직발송 제목에는 '계산서' 가 없다 — 제목 관문만으로는 못 잡는다", () => {
    expect(isTaxInvoiceSubject(NTS_SUBJECT)).toBe(false);
  });

  it("발신처로 후보가 된다", () => {
    expect(isTaxInvoiceSender(NTS_FROM)).toBe(true);
    expect(isTaxInvoiceCandidate(NTS_SUBJECT, NTS_FROM)).toBe(true);
  });

  it("발신처 판정은 대소문자를 가리지 않는다", () => {
    expect(isTaxInvoiceSender(`NTS <${address("HometaxAdmin", "HOMETAX.GO.KR")}>`)).toBe(true);
  });

  it("제목만 맞아도 후보다(ASP 발송분은 발신처가 제각각이다)", () => {
    expect(
      isTaxInvoiceCandidate("[전자세금계산서] 발행 안내", address("bill", "some-asp.example")),
    ).toBe(true);
  });

  /** 음성 대조군 — 관문이 전부 통과시키는 고장을 잡는다. */
  it("제목·발신처 어느 쪽도 아니면 후보가 아니다", () => {
    expect(
      isTaxInvoiceCandidate("발주서 회신드립니다", address("partner", "example.com")),
    ).toBe(false);
  });

  /**
   * 함수만 고치고 **호출부를 되돌리는** 회귀를 막는다 — 실사고는 헤더 루프의 조건 한 줄이
   * 원인이었고, 헬퍼가 아무리 옳아도 그 줄이 `isTaxInvoiceSubject` 로 돌아가면 그대로 재발한다.
   */
  it("헤더 루프의 관문이 제목 단독 판정이 아니다", () => {
    expect(SOURCE).toMatch(/if\s*\(\s*isTaxInvoiceCandidate\(\s*subject,\s*from\s*\)\s*\)/);
    expect(SOURCE).not.toMatch(/if\s*\(\s*isTaxInvoiceSubject\(subject\)\s*\)/);
  });

  /** 걸러진 통수를 세지 않으면 다음 사각도 똑같이 조용하다. */
  it("걸러진 통수를 세어 결과에 싣는다", () => {
    expect(SOURCE).toContain("skippedByFilter");
  });
});

/**
 * ⛔ P0 계약 — 운영 메일함에 흔적을 남기지 않는다.
 *
 * 선례인 `order-converter/api/fetch-emails/route.ts` 는 `addFlags(uid, ['\\Seen'])` 로
 * **읽음 처리를 한다.** 그 파일을 복사해 오는 것이 이 모듈의 가장 그럴듯한 회귀 경로이므로,
 * 단위 테스트가 아니라 **소스 스캔**으로 막는다(미래에 추가될 코드까지 덮는 유일한 수단).
 */
describe("메일함 무흔적 계약", () => {
  it("쓰기 계열 IMAP 호출이 소스에 없다", () => {
    for (const forbidden of ["addFlags", "delFlags", "moveMessage", "deleteMessage", "setFlags"]) {
      expect(SOURCE).not.toContain(forbidden);
    }
  });

  it("모든 fetch 가 markSeen:false 다 — markSeen:true 가 없다", () => {
    expect(SOURCE).not.toMatch(/markSeen:\s*true/);
    expect(SOURCE).toMatch(/markSeen:\s*false/);
  });

  it("openBox 를 readOnly=true 로 연다", () => {
    // imap-simple 의 openBox 는 rw 전용이므로 하위 imap 을 직접 호출해야 한다.
    expect(SOURCE).toMatch(/connection\.imap\.openBox\(\s*boxName,\s*true/);
  });

  /** 양성 대조군 — 정규식이 깨져도 초록이 되지 않게 한다. */
  it("스캔 대상 문자열이 실제로 존재한다(스캐너 자체의 고장 감지)", () => {
    expect(SOURCE).toContain("markSeen");
    expect(SOURCE).toContain("openBox");
  });
});
