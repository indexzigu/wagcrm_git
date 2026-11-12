import { describe, expect, it } from "vitest";
import {
  describeBusinessSync,
  fieldsNeedingSupplement,
  normalizeBusinessValue,
  resolveBusinessFields,
} from "@/lib/partner-business-sync";

describe("normalizeBusinessValue", () => {
  it("treats bizno's no-data dash and blanks as empty", () => {
    expect(normalizeBusinessValue("-")).toBeNull();
    expect(normalizeBusinessValue(" - ")).toBeNull();
    expect(normalizeBusinessValue("－")).toBeNull();
    expect(normalizeBusinessValue("—")).toBeNull();
    expect(normalizeBusinessValue("")).toBeNull();
    expect(normalizeBusinessValue(null)).toBeNull();
    expect(normalizeBusinessValue(undefined)).toBeNull();
  });

  it("keeps real values, including ones that contain a dash", () => {
    expect(normalizeBusinessValue(" 홍길동 ")).toBe("홍길동");
    expect(normalizeBusinessValue("서울 송파구 올림픽로 35-1")).toBe("서울 송파구 올림픽로 35-1");
  });
});

describe("fieldsNeedingSupplement", () => {
  it("asks the mailbox only for fields empty in both bizno and the stored row", () => {
    expect(
      fieldsNeedingSupplement(
        { ceoName: "-", businessType: "도매", businessItem: null, address: "서울" },
        { ceoName: null, businessType: null, businessItem: "-", address: null },
      ),
    ).toEqual(["ceoName", "businessItem"]);
  });

  it("skips the mailbox when bizno filled everything", () => {
    expect(
      fieldsNeedingSupplement(
        {},
        { ceoName: "김대표", businessType: "도매", businessItem: "화장품", address: "서울" },
      ),
    ).toEqual([]);
  });
});

describe("resolveBusinessFields", () => {
  it("fills bizno gaps from the invoice and reports nothing missing", () => {
    const result = resolveBusinessFields({
      current: { ceoName: "-", businessType: null, businessItem: null, address: "-" },
      scraped: { ceoName: null, businessType: null, businessItem: null, address: null },
      invoice: { ceoName: "김대표", businessType: "도소매", businessItem: "화장품", address: "서울" },
    });
    expect(result.updates).toEqual({
      ceoName: "김대표",
      businessType: "도소매",
      businessItem: "화장품",
      address: "서울",
    });
    expect(result.filledFromInvoice).toEqual(["ceoName", "businessType", "businessItem", "address"]);
    expect(result.missingFields).toEqual([]);
  });

  it("clears a stored dash when no source has a value, and lists the core fields as missing", () => {
    const result = resolveBusinessFields({
      current: { ceoName: "-", businessType: null, businessItem: null, address: "-" },
      scraped: { ceoName: "-", businessType: null, businessItem: null, address: "-" },
      invoice: null,
    });
    expect(result.updates).toEqual({ ceoName: null, address: null });
    expect(result.filledFromInvoice).toEqual([]);
    expect(result.missingFields).toEqual(["ceoName", "businessType", "businessItem"]);
  });

  it("prefers bizno over the stored value and the stored value over the invoice", () => {
    const result = resolveBusinessFields({
      current: { ceoName: "옛대표", businessType: "제조", businessItem: null, address: null },
      scraped: { ceoName: "새대표", businessType: null, businessItem: null, address: null },
      invoice: { businessType: "도소매", businessItem: "화장품" },
    });
    expect(result.updates).toEqual({ ceoName: "새대표", businessItem: "화장품" });
    expect(result.filledFromInvoice).toEqual(["businessItem"]);
    expect(result.missingFields).toEqual([]);
  });
});

describe("describeBusinessSync", () => {
  it("warns with the missing field names and the next step", () => {
    const message = describeBusinessSync(
      { missingFields: ["ceoName", "businessType", "businessItem"], invoiceLookup: { status: "NOT_FOUND" } },
      "가나상사",
    );
    expect(message.tone).toBe("warning");
    expect(message.title).toBe("대표자명·업태·종목 정보를 찾지 못했습니다.");
    expect(message.description).toContain("사업자등록증을 올리면 채울 수 있습니다.");
  });

  it("surfaces a mailbox failure instead of hiding it", () => {
    const message = describeBusinessSync(
      { missingFields: ["businessType"], invoiceLookup: { status: "FAILED", message: "IMAP 접속 실패" } },
      null,
    );
    expect(message.description).toContain("메일함 조회 실패: IMAP 접속 실패");
  });

  it("tells a bizno outage apart from missing data", () => {
    const message = describeBusinessSync(
      { missingFields: ["ceoName", "businessType", "businessItem"], biznoFailed: true, invoiceLookup: { status: "NOT_FOUND" } },
      null,
    );
    expect(message.tone).toBe("warning");
    expect(message.description).toContain("사업자 조회 사이트(bizno) 응답 실패");
  });

  it("reports success and names fields taken from invoices", () => {
    const message = describeBusinessSync(
      { missingFields: [], filledFromInvoice: ["businessType", "businessItem"], invoiceLookup: { status: "FOUND" } },
      "가나상사",
    );
    expect(message).toEqual({
      tone: "success",
      title: "사업자 정보가 동기화되었습니다.",
      description: "세금계산서에서 업태·종목 채움",
    });
  });

  it("stays silent on extras when nothing notable happened", () => {
    expect(describeBusinessSync({ missingFields: [] }, "가나상사").description).toBeUndefined();
  });
});
