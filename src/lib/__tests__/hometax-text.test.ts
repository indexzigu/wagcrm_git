/**
 * 홈택스 자유 텍스트 바이트 캡 계약 (T-025).
 *
 * 이 파일이 지키는 것은 "몇 자로 자르나"가 아니라 **"홈택스가 세는 단위로 상한을
 * 지키는가"** 다 — 종전 결함이 정확히 그 축의 혼동이었다(글자 수 200자 캡을 통과한
 * 한글 문자열이 바이트 상한을 넘어 발급 단계에서 거부됨).
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  countHometaxBytes,
  truncateToHometaxBytes,
  HOMETAX_TEXT_MAX_BYTES,
} from "@/lib/hometax-text";

const MARKER = "...(이하 생략)";

describe("countHometaxBytes", () => {
  it("한글은 글자 수가 아니라 UTF-8 바이트로 센다 — 이 차이가 T-025 의 원인이었다", () => {
    expect("가".length).toBe(1);
    expect(countHometaxBytes("가")).toBe(3);
    // 종전 캡(200자)을 통과하던 문자열이 상한을 얼마나 넘는지 — 6배다.
    expect(countHometaxBytes("가".repeat(200))).toBe(600);
  });

  it("ASCII 는 글자 수와 바이트 수가 같다", () => {
    expect(countHometaxBytes("abc-123")).toBe(7);
  });
});

describe("truncateToHometaxBytes", () => {
  it("상한 안이면 손대지 않는다", () => {
    const short = "공동구매 3회차";
    expect(truncateToHometaxBytes(short, MARKER)).toBe(short);
  });

  it("넘으면 마커를 포함해서도 상한을 지킨다 — 마커를 붙여 놓고 초과하면 의미가 없다", () => {
    const long = "긴딜이름입니다".repeat(30);
    const result = truncateToHometaxBytes(long, MARKER);

    expect(countHometaxBytes(result)).toBeLessThanOrEqual(HOMETAX_TEXT_MAX_BYTES);
    expect(result.endsWith(MARKER)).toBe(true);
  });

  it("글자 중간에서 자르지 않는다 — 바이트로 자르면 깨진 문자가 남는다", () => {
    // 3바이트 문자만 늘어놓고 상한을 4로 두면, 바이트 절단은 1글자+1바이트가 된다.
    const result = truncateToHometaxBytes("가나다", "", 4);
    expect(result).toBe("가");
    expect([...result].every((ch) => ch.charCodeAt(0) !== 0xfffd)).toBe(true);
  });

  it("서로게이트 쌍(이모지)도 쪼개지 않는다", () => {
    const result = truncateToHometaxBytes("🙂🙂", "", 5); // 이모지 1개 = 4바이트
    expect(result).toBe("🙂");
  });

  it("마커가 상한보다 크면 마커를 포기하고 본문을 남긴다 — 본문을 통째로 날리지 않는다", () => {
    const result = truncateToHometaxBytes("가나다라", MARKER, 6);
    expect(result).toBe("가나");
  });

  it("어떤 입력이든 결과는 상한을 넘지 않는다", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 200 }), (text, max) => {
        expect(countHometaxBytes(truncateToHometaxBytes(text, MARKER, max))).toBeLessThanOrEqual(max);
      }),
    );
  });
});
