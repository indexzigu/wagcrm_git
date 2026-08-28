import { describe, expect, it } from "vitest";
import { computeRoomKey, normalizeRoomName, TXT_SOURCE } from "../room-key";

describe("room-key — TXT_UPLOAD roomKey 합성", () => {
  it("TXT: 접두어 + 16자 해시 형태를 반환한다", () => {
    const key = computeRoomKey("테스트방");
    expect(key.startsWith("TXT:")).toBe(true);
    expect(key.slice(4)).toHaveLength(16);
  });

  it("동일한 방 이름은 항상 동일한 키를 낸다(결정성)", () => {
    const key1 = computeRoomKey("우리 방 이름");
    const key2 = computeRoomKey("우리 방 이름");
    expect(key1).toBe(key2);
  });

  it("다른 방 이름은 다른 키를 낸다", () => {
    const key1 = computeRoomKey("방A");
    const key2 = computeRoomKey("방B");
    expect(key1).not.toBe(key2);
  });

  it("앞뒤 공백 차이는 같은 키를 낸다(정규화)", () => {
    const key1 = computeRoomKey("  테스트방  ");
    const key2 = computeRoomKey("테스트방");
    expect(key1).toBe(key2);
  });

  it("연속 공백은 1개로 축약되어 같은 키를 낸다", () => {
    const key1 = computeRoomKey("테스트   방");
    const key2 = computeRoomKey("테스트 방");
    expect(key1).toBe(key2);
  });

  it("NFC/NFD 정규화 차이가 있어도 같은 키를 낸다", () => {
    const nfc = "테스트방".normalize("NFC");
    const nfd = "테스트방".normalize("NFD");
    expect(computeRoomKey(nfc)).toBe(computeRoomKey(nfd));
  });

  it("normalizeRoomName은 trim + 연속 공백 축약을 수행한다", () => {
    expect(normalizeRoomName("  a   b  ")).toBe("a b");
  });

  it("TXT_SOURCE 상수는 KAKAO_TXT다", () => {
    expect(TXT_SOURCE).toBe("KAKAO_TXT");
  });
});
