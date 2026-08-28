import { describe, it, expect } from "vitest";
import { describeAttachment } from "./attachment-kind";

/** 합성 버퍼로 판별만 확인한다 — 실파일이 아니라 매직바이트·플래그 계약을 고정한다. */
function zip(flags: number): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.set([0x50, 0x4b, 0x03, 0x04], 0);
  buffer.writeUInt16LE(flags, 6);
  return buffer;
}

function pdf(tail = ""): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("body ".repeat(50)), Buffer.from(tail)]);
}

describe("describeAttachment — 열지 않고 정체만 본다", () => {
  it("표준 XML 파싱에 성공했으면 ETAX_XML", () => {
    expect(describeAttachment(Buffer.from("<TaxInvoice/>"), "a.xml", true)).toEqual({
      kind: "ETAX_XML",
      passwordSuspected: false,
    });
  });

  it("암호 없는 PDF", () => {
    const result = describeAttachment(pdf("trailer<</Root 1 0 R>>"), "invoice.pdf", false);
    expect(result.kind).toBe("PDF");
    expect(result.passwordSuspected).toBe(false);
  });

  /** 오너 정보: 계산서 첨부는 통상 사업자번호를 비밀번호로 요구한다 → 이 갈래가 실제 경로일 수 있다. */
  it("트레일러에 /Encrypt 가 있으면 비밀번호 필요 의심", () => {
    const result = describeAttachment(pdf("trailer<</Encrypt 9 0 R>>"), "invoice.pdf", false);
    expect(result.kind).toBe("PDF_ENCRYPTED_SUSPECTED");
    expect(result.passwordSuspected).toBe(true);
  });

  it("암호화된 ZIP 은 로컬 헤더 플래그 bit0 로 판별한다", () => {
    expect(describeAttachment(zip(0x0001), "x.zip", false)).toEqual({
      kind: "ZIP_ENCRYPTED_SUSPECTED",
      passwordSuspected: true,
    });
    expect(describeAttachment(zip(0x0000), "x.zip", false).kind).toBe("ZIP");
  });

  it("xlsx 는 ZIP 컨테이너지만 확장자로 가른다", () => {
    expect(describeAttachment(zip(0x0000), "발주서.xlsx", false).kind).toBe("XLSX");
  });

  it("파일명·MIME 이 아니라 매직바이트를 믿는다", () => {
    // 발행처가 PDF 를 엉뚱한 확장자로 붙여도 PDF 로 본다.
    expect(describeAttachment(pdf(), "attachment.dat", false).kind).toBe("PDF");
    // 반대로 이름만 .xml 이고 내용이 PDF 면 XML 로 오판하지 않는다.
    expect(describeAttachment(pdf(), "invoice.xml", false).kind).toBe("PDF");
  });

  it("표준이 아닌 XML 은 XML_UNRECOGNIZED 로 남긴다(버리지 않는다)", () => {
    expect(describeAttachment(Buffer.from("<?xml version=\"1.0\"?><Other/>"), "x.xml", false).kind).toBe(
      "XML_UNRECOGNIZED",
    );
  });

  it("정체불명은 OTHER", () => {
    expect(describeAttachment(Buffer.from([0x00, 0x01, 0x02, 0x03]), "x.bin", false).kind).toBe("OTHER");
  });

  it("빈 버퍼에서 터지지 않는다", () => {
    expect(describeAttachment(Buffer.alloc(0), null, false).kind).toBe("OTHER");
  });
});
