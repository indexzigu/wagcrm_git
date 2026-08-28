import { describe, expect, it } from "vitest";
import { chunkMessages, detectRoomType } from "../txt-chunker";
import type { ParsedMessage } from "../txt-parser";

function msg(sender: string, isoDate: string, text: string): ParsedMessage {
  return { sender, sentAt: new Date(isoDate), text };
}

describe("detectRoomType — 고유 발신자 수 기반 판정", () => {
  it("고유 발신자가 3명 이상이면 GROUP이다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:01:00Z", "hi"),
      msg("C", "2026-07-01T00:02:00Z", "hi"),
    ];
    expect(detectRoomType(messages)).toBe("GROUP");
  });

  it("고유 발신자가 2명 이하면 DIRECT다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:01:00Z", "hi"),
    ];
    expect(detectRoomType(messages)).toBe("DIRECT");
  });

  it("단일 발신자만 있어도 DIRECT다", () => {
    const messages = [msg("A", "2026-07-01T00:00:00Z", "hi")];
    expect(detectRoomType(messages)).toBe("DIRECT");
  });
});

describe("chunkMessages — 시간 갭 기반 결정적 청킹", () => {
  it("빈 배열은 빈 청크를 반환한다", () => {
    expect(chunkMessages([], { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" })).toEqual([]);
  });

  it("GROUP: 600초 이하 갭은 같은 청크로 묶인다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:09:00Z", "hi"), // 540s gap
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].messageCount).toBe(2);
  });

  it("GROUP: 600초 초과 갭은 새 청크를 시작한다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:11:00Z", "hi"), // 660s gap > 600s
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks).toHaveLength(2);
  });

  it("DIRECT: 1800초 이하 갭은 같은 청크로 묶인다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:29:00Z", "hi"), // 1740s gap
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    expect(chunks).toHaveLength(1);
  });

  it("DIRECT: 1800초 초과 갭은 새 청크를 시작한다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:31:00Z", "hi"), // 1860s gap > 1800s
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    expect(chunks).toHaveLength(2);
  });

  it("chunkId는 roomKey+시작시각 기반으로 결정적으로 합성된다", () => {
    const messages = [msg("A", "2026-07-01T00:00:00Z", "hi")];
    const chunks1 = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    const chunks2 = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    expect(chunks1[0].chunkId).toBe(chunks2[0].chunkId);
    expect(chunks1[0].chunkId).toContain("TXT:abc");
  });

  it("text는 [HH:mm] 발신자: 내용 줄 결합이다", () => {
    const messages = [msg("홍길동", "2026-07-01T00:00:00Z", "안녕하세요")];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    // KST = UTC+9 => 09:00
    expect(chunks[0].text).toBe("[09:00] 홍길동: 안녕하세요");
  });

  it("senderNickname은 청크 내 첫 발신자다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:01:00Z", "hi"),
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks[0].senderNickname).toBe("A");
  });

  it("정렬되지 않은 입력도 시간순으로 정렬해 청킹한다(결정성)", () => {
    const messages = [
      msg("B", "2026-07-01T00:01:00Z", "second"),
      msg("A", "2026-07-01T00:00:00Z", "first"),
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.split("\n")[0]).toContain("first");
  });

  it("동일 입력을 2회 실행해도 결과가 동일하다(결정성)", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("B", "2026-07-01T00:20:00Z", "hi"),
      msg("A", "2026-07-01T01:00:00Z", "hi"),
    ];
    const options = { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" as const };
    const chunks1 = chunkMessages(messages, options);
    const chunks2 = chunkMessages(messages, options);
    expect(chunks1).toEqual(chunks2);
  });

  it("startedAt/endedAt은 청크 내 첫/마지막 메시지 시각이다", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00Z", "hi"),
      msg("A", "2026-07-01T00:02:00Z", "hi2"),
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks[0].startedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(chunks[0].endedAt).toBe("2026-07-01T00:02:00.000Z");
  });
});

describe("chunkMessages — m8: 정확 경계값(gapMs > threshold 시맨틱 고정)", () => {
  it("GROUP: 갭이 정확히 600000ms(600s)이면 같은 청크다(경계=포함)", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00.000Z", "hi"),
      msg("B", "2026-07-01T00:10:00.000Z", "hi"), // 정확히 600000ms
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks).toHaveLength(1);
  });

  it("GROUP: 갭이 600001ms(600s+1ms)이면 새 청크다(경계 초과)", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00.000Z", "hi"),
      msg("B", "2026-07-01T00:10:00.001Z", "hi"), // 600001ms
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "GROUP" });
    expect(chunks).toHaveLength(2);
  });

  it("DIRECT: 갭이 정확히 1800000ms(1800s)이면 같은 청크다(경계=포함)", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00.000Z", "hi"),
      msg("B", "2026-07-01T00:30:00.000Z", "hi"), // 정확히 1800000ms
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    expect(chunks).toHaveLength(1);
  });

  it("DIRECT: 갭이 1800001ms(1800s+1ms)이면 새 청크다(경계 초과)", () => {
    const messages = [
      msg("A", "2026-07-01T00:00:00.000Z", "hi"),
      msg("B", "2026-07-01T00:30:00.001Z", "hi"), // 1800001ms
    ];
    const chunks = chunkMessages(messages, { roomKey: "TXT:abc", roomName: "방", roomType: "DIRECT" });
    expect(chunks).toHaveLength(2);
  });
});
