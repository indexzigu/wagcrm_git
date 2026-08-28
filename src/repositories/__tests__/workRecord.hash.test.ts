import { describe, expect, it } from "vitest";
import { computeSourceHash } from "../workRecordRepository";

// 멱등 해시 결정성 검증: sha256(roomKey+sentAt+sender+rawText).
// 동일 입력은 항상 동일 해시를 내야 하고(멱등), 어느 한 필드라도 다르면 해시가 달라져야 한다.

describe("computeSourceHash — 결정성", () => {
  const base = {
    roomKey: "room-1",
    sentAt: new Date("2026-07-05T10:00:00.000Z"),
    sender: "김철수",
    rawText: "안녕하세요, 정산 문의드립니다.",
  };

  it("동일 입력에 대해 항상 동일한 해시를 반환한다", () => {
    const h1 = computeSourceHash(base);
    const h2 = computeSourceHash({ ...base });
    expect(h1).toBe(h2);
  });

  it("Date 객체와 동일 시각의 ISO 문자열은 같은 해시를 낸다", () => {
    const withDate = computeSourceHash(base);
    const withString = computeSourceHash({ ...base, sentAt: base.sentAt.toISOString() });
    expect(withDate).toBe(withString);
  });

  it("sha256 hex 다이제스트 형식(64자 16진수)을 반환한다", () => {
    const hash = computeSourceHash(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("roomKey가 다르면 해시가 달라진다", () => {
    const h1 = computeSourceHash(base);
    const h2 = computeSourceHash({ ...base, roomKey: "room-2" });
    expect(h1).not.toBe(h2);
  });

  it("sentAt이 다르면 해시가 달라진다 (동일 초 다중 메시지 구분)", () => {
    const h1 = computeSourceHash(base);
    const h2 = computeSourceHash({ ...base, sentAt: new Date("2026-07-05T10:00:01.000Z") });
    expect(h1).not.toBe(h2);
  });

  it("sender가 다르면 해시가 달라진다", () => {
    const h1 = computeSourceHash(base);
    const h2 = computeSourceHash({ ...base, sender: "이영희" });
    expect(h1).not.toBe(h2);
  });

  it("rawText가 다르면 해시가 달라진다", () => {
    const h1 = computeSourceHash(base);
    const h2 = computeSourceHash({ ...base, rawText: "다른 내용입니다." });
    expect(h1).not.toBe(h2);
  });

  it("roomKey/sender가 null이어도 안정적으로 해시를 생성한다 (미귀속 케이스)", () => {
    const h1 = computeSourceHash({ ...base, roomKey: null, sender: null });
    const h2 = computeSourceHash({ ...base, roomKey: null, sender: null });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(computeSourceHash(base));
  });
});
