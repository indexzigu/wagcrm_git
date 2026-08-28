import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  parseNtsSecureMailHtml,
  verifyNtsPassword,
  openNtsAttachments,
  isNtsSecureMailHtml,
  deriveNtsKey,
} from "./nts-secure-mail";
import { seedEncryptBlock } from "./seed-cipher";
import { parseEtaxInvoiceXml } from "./etax-xml";

/**
 * 실제 국세청 첨부는 셀러 상호·사업자번호·금액이 들어 있어 픽스처로 쓸 수 없다(P0 — public
 * 레포). 그래서 **같은 구조의 봉투를 합성**한다 — 구조·복호화 경로는 실물과 동일하고 값만
 * 가짜다. 실물 대조는 세션에서 1회 수행했고 그 결과는 설계 문서에 기록했다.
 */

const PASSWORD = "1112233333"; // 가짜 사업자번호 10자리

const FAKE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<TaxInvoice>
  <ExchangedDocument><ID>DOC-1</ID><IssueDateTime>20260804010203</IssueDateTime></ExchangedDocument>
  <TaxInvoiceDocument>
    <IssueID>202608041234567890123456</IssueID>
    <TypeCode>0101</TypeCode>
    <IssueDateTime>20260731</IssueDateTime>
    <PurposeCode>02</PurposeCode>
  </TaxInvoiceDocument>
  <TaxInvoiceTradeSettlement>
    <InvoicerParty><ID>9998877777</ID><NameText>발행사</NameText></InvoicerParty>
    <InvoiceeParty><ID>1112233333</ID><NameText>수취사</NameText></InvoiceeParty>
    <SpecifiedMonetarySummation>
      <ChargeTotalAmount>2000000</ChargeTotalAmount>
      <TaxTotalAmount>200000</TaxTotalAmount>
      <GrandTotalAmount>2200000</GrandTotalAmount>
    </SpecifiedMonetarySummation>
  </TaxInvoiceTradeSettlement>
</TaxInvoice>`;

/** SEED-CBC(IV=0) + PKCS#7 로 암호화해 base64 로 만든다 — 국세청 봉투가 쓰는 규약. */
function encryptToBase64(plain: Buffer, key: Buffer): string {
  const padLength = 16 - (plain.length % 16);
  const padded = Buffer.concat([plain, Buffer.alloc(padLength, padLength)]);
  const out = Buffer.alloc(padded.length);
  let prev: Uint8Array = new Uint8Array(16);
  for (let offset = 0; offset < padded.length; offset += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) block[i] = padded[offset + i] ^ prev[i];
    const encrypted = seedEncryptBlock(block, new Uint8Array(key));
    out.set(encrypted, offset);
    prev = encrypted;
  }
  return out.toString("base64");
}

function buildEnvelopeHtml(options: { password?: string; algorithm?: string } = {}): string {
  const password = options.password ?? PASSWORD;
  const key = createHash("md5").update(password, "utf8").digest();
  const xmlBytes = Buffer.from(FAKE_XML, "utf8");

  // 첨부는 "원본을 base64 로 만든 문자열"을 암호화한다(실물이 그렇다).
  const attachCipher = encryptToBase64(Buffer.from(xmlBytes.toString("base64"), "utf8"), key);
  const hashCipher = encryptToBase64(Buffer.from(key.toString("hex"), "utf8"), key);

  const headerLines = [
    `ContentEncryptionAlgorithm:${options.algorithm ?? "2"}`,
    "HintKey:주민등록번호(13자리), 사업자인 경우는 사업자등록번호(10자리)를 입력하시기 바랍니다.",
    `HashKey:${hashCipher}`,
    "AttachFileCount:1",
    "AttachFileName:202608041234567890123456.xml",
    "AttachFileTagID:idCriAttachContents0",
    `AttachFileSize:${xmlBytes.length}`,
  ].join("\r\n");

  const headerBuffer = Buffer.from(headerLines, "utf8");
  const obfuscated = Buffer.allocUnsafe(headerBuffer.length);
  for (let i = 0; i < headerBuffer.length; i += 1) obfuscated[i] = headerBuffer[i] ^ 0x6b;

  return `<!DOCTYPE html><html><body>
<input type="hidden" id="idCriHeader" value="${obfuscated.toString("base64")}">
<input type="hidden" id="idCriPcContents" value="${encryptToBase64(Buffer.from("본문", "utf8"), key)}">
<input type="hidden" id="idCriAttachContents0" value="${attachCipher}">
</body></html>`;
}

describe("보안메일 봉투 판별·파싱", () => {
  it("보안메일이 아닌 HTML 은 null", () => {
    expect(isNtsSecureMailHtml("<html><body>안내메일</body></html>")).toBe(false);
    expect(parseNtsSecureMailHtml("<html><body>안내메일</body></html>")).toBeNull();
  });

  it("비밀번호 없이도 헤더는 읽힌다 — 첨부 목록·승인번호를 미리 알 수 있다", () => {
    const envelope = parseNtsSecureMailHtml(buildEnvelopeHtml())!;
    expect(envelope.algorithm).toBe("SEED");
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.attachments[0].filename).toBe("202608041234567890123456.xml");
    expect(envelope.attachments[0].tagId).toBe("idCriAttachContents0");
    expect(envelope.hintKey).toContain("사업자등록번호(10자리)");
  });

  it("알고리즘 코드를 참조 구현과 같게 해석한다", () => {
    expect(parseNtsSecureMailHtml(buildEnvelopeHtml({ algorithm: "1" }))!.algorithm).toBe("AES");
    expect(parseNtsSecureMailHtml(buildEnvelopeHtml({ algorithm: "3" }))!.algorithm).toBe("ARIA");
    expect(parseNtsSecureMailHtml(buildEnvelopeHtml({ algorithm: "2" }))!.algorithm).toBe("SEED");
  });
});

describe("비밀번호 검증", () => {
  it("맞는 비밀번호는 통과, 틀린 비밀번호는 거부", () => {
    const envelope = parseNtsSecureMailHtml(buildEnvelopeHtml())!;
    expect(verifyNtsPassword(envelope, PASSWORD)).toBe(true);
    expect(verifyNtsPassword(envelope, "0000000000")).toBe(false);
  });

  /** 복호 전에 판별할 수 있다는 것이 이 설계의 요점 — 쓰레기를 계산서로 오해석하지 않는다. */
  it("HashKey 가 없으면 검증 실패로 본다(통과시키지 않는다)", () => {
    const envelope = parseNtsSecureMailHtml(buildEnvelopeHtml())!;
    expect(verifyNtsPassword({ ...envelope, hashKey: null }, PASSWORD)).toBe(false);
  });

  it("키는 MD5(비밀번호) 16바이트다", () => {
    expect(deriveNtsKey(PASSWORD)).toHaveLength(16);
  });
});

describe("첨부 복호 → 표준 XML", () => {
  it("복호 + base64 디코드까지 끝내 원본 바이트를 돌려준다", () => {
    const envelope = parseNtsSecureMailHtml(buildEnvelopeHtml())!;
    const [attachment] = openNtsAttachments(envelope, PASSWORD);
    expect(attachment.filename).toBe("202608041234567890123456.xml");
    // 헤더 선언 크기와 실제가 맞아야 한다 — base64 디코드를 빠뜨리면 여기서 걸린다.
    expect(attachment.sizeMatches).toBe(true);
    expect(attachment.content.toString("utf8")).toContain("<TaxInvoice>");
  });

  it("우리 파서가 그 바이트를 그대로 읽는다(전 경로 연결)", () => {
    const envelope = parseNtsSecureMailHtml(buildEnvelopeHtml())!;
    const [attachment] = openNtsAttachments(envelope, PASSWORD);
    const parsed = parseEtaxInvoiceXml(attachment.content);
    expect(parsed?.issueId).toBe("202608041234567890123456");
    expect(parsed?.writtenDate).toBe("2026-07-31");
    expect(parsed?.invoiceeBusinessNumber).toBe("1112233333");
    expect(parsed?.amounts.totalAmount).toBe(2200000);
  });

  it("틀린 비밀번호로 열면 던진다 — 쓰레기를 계산서로 흘리지 않는다", () => {
    const envelope = parseNtsSecureMailHtml(buildEnvelopeHtml())!;
    expect(() => openNtsAttachments(envelope, "0000000000")).toThrow();
  });
});
