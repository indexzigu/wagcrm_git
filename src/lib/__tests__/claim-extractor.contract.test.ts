import { describe, expect, it } from "vitest";
import {
  dropUngroundedCandidates,
  parseCandidates,
  type ClaimCandidate,
} from "@/lib/claims/claim-extractor";

/**
 * AI 클레임 추출(C1 M3)의 방어선 계약.
 *
 * 프롬프트는 **지시일 뿐 보증이 아니다** — 모델이 규칙을 어기고 자료에 없는
 * 소구점을 지어내거나 근거 없이 evidenceType 을 올려도, 이 두 함수가 걸러야
 * 한다. 여기가 뚫리면 레지스트리가 "AI가 만든 근거"의 통로가 되고, 그 표현이
 * 승인을 거쳐 셀러에게 나간다.
 *
 * 완화는 오너 승인 사안이다.
 */

const SOURCE = `[제품명] 데일리 웰니스 패키지
국내산 유기농 원료를 사용했습니다. 시험성적서 KTR-2026-1234 보유.
1일 1포, 물과 함께 섭취하세요. 임산부는 섭취 전 전문가와 상담하세요.`;

describe("parseCandidates — 응답 형식 방어", () => {
  it("배열이 아니면 빈 목록", () => {
    expect(parseCandidates(null)).toEqual([]);
    expect(parseCandidates({})).toEqual([]);
    expect(parseCandidates({ candidates: "nope" })).toEqual([]);
  });

  it("알 수 없는 kind 나 빈 text 는 버린다", () => {
    const out = parseCandidates({
      candidates: [
        { kind: "MADE_UP", text: "무언가" },
        { kind: "APPROVED_CLAIM", text: "   " },
        { kind: "APPROVED_CLAIM", text: "국내산 유기농 원료" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("국내산 유기농 원료");
  });

  it("모르는 evidenceType 은 NEEDS_SOURCE 로 떨어뜨린다 (상향 금지)", () => {
    const out = parseCandidates({
      candidates: [
        {
          kind: "APPROVED_CLAIM",
          text: "원료 A",
          evidenceType: "VERIFIED_BY_AI",
        },
        { kind: "APPROVED_CLAIM", text: "원료 B" },
      ],
    });
    expect(out.map((c) => c.evidenceType)).toEqual([
      "NEEDS_SOURCE",
      "NEEDS_SOURCE",
    ]);
  });

  it("허용된 evidenceType 은 보존한다", () => {
    const out = parseCandidates({
      candidates: [
        { kind: "APPROVED_CLAIM", text: "원료", evidenceType: "MEASURED" },
      ],
    });
    expect(out[0].evidenceType).toBe("MEASURED");
  });

  it("과도한 길이는 잘라 저장 한도를 지킨다", () => {
    const out = parseCandidates({
      candidates: [{ kind: "APPROVED_CLAIM", text: "가".repeat(900) }],
    });
    expect(out[0].text.length).toBe(500);
  });

  it("후보 수를 20건으로 제한한다", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      kind: "APPROVED_CLAIM",
      text: `후보 ${i}`,
    }));
    expect(parseCandidates({ candidates: many })).toHaveLength(20);
  });
});

describe("dropUngroundedCandidates — 창작 차단", () => {
  const claim = (text: string, quote: string | null): ClaimCandidate => ({
    kind: "APPROVED_CLAIM",
    text,
    evidence: null,
    evidenceType: "NEEDS_SOURCE",
    quote,
  });

  it("자료에 실제로 있는 소구점은 통과시킨다", () => {
    const out = dropUngroundedCandidates(
      [claim("국내산 유기농 원료 사용", "국내산 유기농 원료를 사용했습니다")],
      SOURCE,
    );
    expect(out).toHaveLength(1);
  });

  it("자료에 없는 소구점은 버린다 (모델이 지어낸 경우)", () => {
    const out = dropUngroundedCandidates(
      [claim("피부 미백에 효과적", "피부 미백에 효과적입니다")],
      SOURCE,
    );
    expect(out).toHaveLength(0);
  });

  it("quote 는 진짜인데 text 에 없는 말을 얹으면 버린다 (우회 차단)", () => {
    // 등록되는 것은 text 다 — quote 만 대조하면 이 경로가 열린다(리뷰 HIGH).
    const out = dropUngroundedCandidates(
      [claim("국내산 최고 품질 원료", "국내산 유기농 원료를 사용했습니다")],
      SOURCE,
    );
    expect(out).toHaveLength(0);
  });

  it("자료 문장의 축약·재배열은 통과시킨다 (정상 추출)", () => {
    const out = dropUngroundedCandidates(
      [claim("국내산 유기농 원료 사용", "국내산 유기농 원료를 사용했습니다")],
      SOURCE,
    );
    expect(out).toHaveLength(1);
  });

  it("quote 가 창작이면 text 가 멀쩡해도 버린다", () => {
    const out = dropUngroundedCandidates(
      [claim("1일 1포", "임상시험에서 효과가 입증되었습니다")],
      SOURCE,
    );
    expect(out).toHaveLength(0);
  });

  it("공백·줄바꿈 차이는 통과시킨다", () => {
    const out = dropUngroundedCandidates(
      [claim("시험성적서 보유", "시험성적서   KTR-2026-1234\n보유")],
      SOURCE,
    );
    expect(out).toHaveLength(1);
  });

  it("quote 가 없으면 text 로 대조한다", () => {
    expect(
      dropUngroundedCandidates([claim("1일 1포", null)], SOURCE),
    ).toHaveLength(1);
    expect(
      dropUngroundedCandidates([claim("1일 3포", null)], SOURCE),
    ).toHaveLength(0);
  });

  it("금지 표현·필수 고지는 자료에 없어도 남긴다 (새로 경고하는 것이 정상)", () => {
    const warnings: ClaimCandidate[] = [
      {
        kind: "BANNED_PHRASE",
        text: "질병 치료 효과",
        evidence: null,
        evidenceType: "NEEDS_SOURCE",
        quote: null,
      },
      {
        kind: "REQUIRED_DISCLOSURE",
        text: "유료 광고 포함",
        evidence: null,
        evidenceType: "NEEDS_SOURCE",
        quote: null,
      },
    ];
    expect(dropUngroundedCandidates(warnings, SOURCE)).toHaveLength(2);
  });
});
