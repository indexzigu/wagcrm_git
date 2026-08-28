import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKakaoTxt } from "../txt-parser";

// 합성 픽스처만 사용 — 실 카톡 원문은 절대 사용하지 않는다.

const FIXTURES_DIR = join(__dirname, "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

describe("parseKakaoTxt — 변형 A ([발신자] [오전/오후 h:mm] 내용)", () => {
  const raw = readFixture("variant-a.txt");

  it("헤더에서 방 이름을 추출한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    expect(result.roomName).toBe("테스트방A");
  });

  it("저장한 날짜 행을 스킵한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    expect(result.messages.some((m) => m.text.includes("저장한 날짜"))).toBe(false);
  });

  it("시스템 메시지(입장) 및 첨부 단독 행(사진/이모티콘)을 제외한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    const texts = result.messages.map((m) => m.text);
    expect(texts.some((t) => t.includes("들어왔습니다"))).toBe(false);
    expect(texts).not.toContain("사진");
    expect(texts).not.toContain("이모티콘");
  });

  it("멀티라인 메시지는 직전 메시지에 append된다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    const msg = result.messages.find((m) => m.text.startsWith("오늘 회의 관련해서"));
    expect(msg).toBeDefined();
    expect(msg?.text).toContain("추가로 자료도 첨부할게요");
  });

  it("오전 12시는 0시(자정)로 해석한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    const msg = result.messages.find((m) => m.text === "점심 드셨나요");
    expect(msg).toBeDefined();
    // KST 00:00 = UTC 전날 15:00
    expect(msg?.sentAt.getUTCHours()).toBe(15);
  });

  it("오후 12시는 12시(정오)로 해석한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    const msg = result.messages.find((m) => m.text === "아직이요");
    expect(msg).toBeDefined();
    // KST 12:30 = UTC 03:30
    expect(msg?.sentAt.getUTCHours()).toBe(3);
    expect(msg?.sentAt.getUTCMinutes()).toBe(30);
  });

  it("날짜 구분선 이후 컨텍스트로 다음날 메시지의 날짜를 올바르게 유지한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    const msg = result.messages.find((m) => m.text === "다음날 메시지입니다");
    expect(msg).toBeDefined();
    // 2026-07-02 08:00 KST = 2026-07-01 23:00 UTC
    expect(msg?.sentAt.toISOString()).toBe("2026-07-01T23:00:00.000Z");
  });

  it("같은 입력을 두 번 파싱해도 동일한 결과를 낸다(결정성)", () => {
    const result1 = parseKakaoTxt(raw, "variant-a.txt");
    const result2 = parseKakaoTxt(raw, "variant-a.txt");
    expect(result1.messages.map((m) => ({ ...m, sentAt: m.sentAt.toISOString() }))).toEqual(
      result2.messages.map((m) => ({ ...m, sentAt: m.sentAt.toISOString() }))
    );
    expect(result1.roomName).toBe(result2.roomName);
  });

  it("발신자별 메시지 수가 예상과 일치한다", () => {
    const result = parseKakaoTxt(raw, "variant-a.txt");
    const senders = result.messages.map((m) => m.sender);
    expect(senders.filter((s) => s === "홍길동").length).toBeGreaterThanOrEqual(3);
    expect(senders).toContain("김철수");
  });
});

describe("parseKakaoTxt — 변형 B (yyyy년 M월 d일 오전/오후 h:mm, 발신자 : 내용)", () => {
  const raw = readFixture("variant-b.txt");

  it("헤더에서 방 이름을 추출한다", () => {
    const result = parseKakaoTxt(raw, "variant-b.txt");
    expect(result.roomName).toBe("테스트방B");
  });

  it("멀티라인 메시지는 직전 메시지에 append된다", () => {
    const result = parseKakaoTxt(raw, "variant-b.txt");
    const msg = result.messages.find((m) => m.text.startsWith("오늘 회의 관련해서"));
    expect(msg).toBeDefined();
    expect(msg?.text).toContain("추가로 자료도 첨부할게요");
  });

  it("오전 12시/오후 12시 경계를 올바르게 해석한다", () => {
    const result = parseKakaoTxt(raw, "variant-b.txt");
    const noon = result.messages.find((m) => m.text === "아직이요");
    const midnight = result.messages.find((m) => m.text === "점심 드셨나요");
    expect(noon?.sentAt.getUTCHours()).toBe(3);
    expect(midnight?.sentAt.getUTCHours()).toBe(15);
  });

  it("첨부 단독 행(사진/이모티콘)을 제외한다", () => {
    const result = parseKakaoTxt(raw, "variant-b.txt");
    const texts = result.messages.map((m) => m.text);
    expect(texts).not.toContain("사진");
    expect(texts).not.toContain("이모티콘");
  });

  it("같은 입력을 두 번 파싱해도 동일한 결과를 낸다(결정성)", () => {
    const result1 = parseKakaoTxt(raw, "variant-b.txt");
    const result2 = parseKakaoTxt(raw, "variant-b.txt");
    expect(result1.messages.length).toBe(result2.messages.length);
    expect(result1.messages.map((m) => m.sentAt.toISOString())).toEqual(
      result2.messages.map((m) => m.sentAt.toISOString())
    );
  });
});

describe("parseKakaoTxt — 헤더 추출 실패 fallback", () => {
  it("헤더 패턴에 맞지 않으면 경고를 남기고 파일명으로 대체한다", () => {
    const raw = "2026년 7월 1일 오전 9:00, 홍길동 : 안녕하세요\n";
    const result = parseKakaoTxt(raw, "unknown-room.txt");
    expect(result.roomName).toBe("unknown-room");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseKakaoTxt — M1(PII): warnings에 원문 대화 조각이 노출되지 않는다", () => {
  it("헤더 추출 실패 경고에 원문 라인이 포함되지 않는다(파일명만 언급)", () => {
    const raw = "이상한 헤더가 아닌 라인입니다\n2026년 7월 1일 오전 9:00, 홍길동 : 극비 대화 내용입니다\n";
    const result = parseKakaoTxt(raw, "secret-room.txt");
    const serializedWarnings = result.warnings.join("\n");
    expect(serializedWarnings).not.toContain("극비 대화 내용입니다");
    expect(serializedWarnings).not.toContain("이상한 헤더가 아닌 라인입니다");
  });

  it("날짜 컨텍스트 없는 메시지 스킵 경고는 원문 없이 건수만 담는다", () => {
    // 날짜 구분선 없이 바로 변형 A 메시지가 나오는 경우 — 날짜 컨텍스트 미확보로 스킵되어야 한다.
    const raw = "테스트방 님과 카카오톡 대화\n[홍길동] [오전 9:00] 극비 회의록 내용\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const serializedWarnings = result.warnings.join("\n");
    expect(serializedWarnings).not.toContain("극비 회의록 내용");
    expect(serializedWarnings).toMatch(/1건/);
  });

  it("여러 건이 스킵되면 정확한 건수를 집계한다", () => {
    const raw = [
      "테스트방 님과 카카오톡 대화",
      "[홍길동] [오전 9:00] 첫번째 메시지",
      "[김철수] [오전 9:01] 두번째 메시지",
      "[이영희] [오전 9:02] 세번째 메시지",
      "",
    ].join("\n");
    const result = parseKakaoTxt(raw, "room.txt");
    const serializedWarnings = result.warnings.join("\n");
    expect(serializedWarnings).toMatch(/3건/);
  });
});

describe("parseKakaoTxt — M2: 변형 B 발신자명에 콜론이 포함된 경우", () => {
  it("발신자명이 '부서:영업팀'이어도 ' : ' 구분자로만 분리한다", () => {
    const raw = "테스트방 카카오톡 대화\n2026년 7월 1일 오전 9:00, 부서:영업팀 : 안녕하세요\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const msg = result.messages.find((m) => m.text === "안녕하세요");
    expect(msg).toBeDefined();
    expect(msg?.sender).toBe("부서:영업팀");
  });
});

describe("parseKakaoTxt — M3: 시스템메시지 필터가 실메시지를 오탐 소실하지 않는다", () => {
  it("본문이 '...나갔습니다'로 끝나는 파싱된 메시지는 보존된다", () => {
    const raw =
      "테스트방 카카오톡 대화\n" +
      "2026년 7월 1일 오전 9:00, 홍길동 : 아까 미팅 중에 김대리님이 나갔습니다\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const msg = result.messages.find((m) => m.text.includes("나갔습니다"));
    expect(msg).toBeDefined();
    expect(msg?.text).toBe("아까 미팅 중에 김대리님이 나갔습니다");
  });

  it("bare 시스템 라인(prefix 없는 독립 행)은 제거된다", () => {
    const raw =
      "테스트방A 님과 카카오톡 대화\n" +
      "--------------- 2026년 7월 1일 수요일 ---------------\n" +
      "[홍길동] [오전 9:00] 안녕하세요\n" +
      "김철수님이 들어왔습니다.\n" +
      "[홍길동] [오전 9:01] 반갑습니다\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const texts = result.messages.map((m) => m.text);
    expect(texts.some((t) => t.includes("들어왔습니다"))).toBe(false);
    expect(texts).toContain("안녕하세요");
    expect(texts).toContain("반갑습니다");
  });

  it("본문이 '사진' 단독이면 제외되지만 '사진 보냈어요'는 보존된다", () => {
    const raw =
      "테스트방 카카오톡 대화\n" +
      "2026년 7월 1일 오전 9:00, 홍길동 : 사진\n" +
      "2026년 7월 1일 오전 9:01, 홍길동 : 사진 보냈어요\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const texts = result.messages.map((m) => m.text);
    expect(texts).not.toContain("사진");
    expect(texts).toContain("사진 보냈어요");
  });

  it("bare 시스템 라인을 만나도 lastMessage가 리셋되지 않아 후속 멀티라인이 보존된다", () => {
    const raw =
      "테스트방 카카오톡 대화\n" +
      "2026년 7월 1일 오전 9:00, 홍길동 : 첫 줄 메시지\n" +
      "김철수님이 들어왔습니다.\n" +
      "두번째 줄(멀티라인 연속)\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const msg = result.messages.find((m) => m.text.startsWith("첫 줄 메시지"));
    expect(msg).toBeDefined();
    expect(msg?.text).toContain("두번째 줄(멀티라인 연속)");
  });
});

describe("parseKakaoTxt — M4: 날짜구분선 오인식 방지(연대순 가드)", () => {
  it("과거 날짜 문자열과 동일한 연속행은 날짜 구분선으로 오인되지 않고 append된다", () => {
    const raw =
      "테스트방A 님과 카카오톡 대화\n" +
      "--------------- 2026년 7월 5일 일요일 ---------------\n" +
      "[홍길동] [오전 9:00] 지난번에 있었던 일인데요\n" +
      "2026년 7월 1일 화요일\n" + // 날짜 문자열과 동일하지만 과거 날짜 → 구분선 아님
      "그날 회의가 있었어요\n" +
      "[김철수] [오전 9:05] 네 기억납니다\n";
    const result = parseKakaoTxt(raw, "room.txt");

    const msg = result.messages.find((m) => m.text.startsWith("지난번에 있었던 일인데요"));
    expect(msg).toBeDefined();
    expect(msg?.text).toContain("2026년 7월 1일 화요일");
    expect(msg?.text).toContain("그날 회의가 있었어요");

    // 날짜 컨텍스트는 여전히 7월 5일로 유지되어야 한다(구분선으로 오인되지 않았으므로).
    const nextMsg = result.messages.find((m) => m.text === "네 기억납니다");
    expect(nextMsg).toBeDefined();
    // KST 2026-07-05 09:05 = UTC 2026-07-05 00:05
    expect(nextMsg?.sentAt.toISOString()).toBe("2026-07-05T00:05:00.000Z");
  });

  it("미래(연대순 정상 진행) 날짜 구분선은 정상적으로 컨텍스트를 전진시킨다", () => {
    const raw =
      "테스트방A 님과 카카오톡 대화\n" +
      "--------------- 2026년 7월 1일 수요일 ---------------\n" +
      "[홍길동] [오전 9:00] 첫날 메시지\n" +
      "--------------- 2026년 7월 2일 목요일 ---------------\n" +
      "[홍길동] [오전 9:00] 둘째날 메시지\n";
    const result = parseKakaoTxt(raw, "room.txt");
    const msg = result.messages.find((m) => m.text === "둘째날 메시지");
    expect(msg).toBeDefined();
    // KST 2026-07-02 09:00 = UTC 2026-07-02 00:00
    expect(msg?.sentAt.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  it("멀티라인 진행 중 날짜가 전진되면 원문 없이 경고를 남긴다", () => {
    const raw =
      "테스트방A 님과 카카오톡 대화\n" +
      "--------------- 2026년 7월 1일 수요일 ---------------\n" +
      "[홍길동] [오전 9:00] 첫 줄 메시지\n" +
      "--------------- 2026년 7월 2일 목요일 ---------------\n"; // 멀티라인 진행 중(lastMessage 존재) 날짜 전진
    const result = parseKakaoTxt(raw, "room.txt");
    const serializedWarnings = result.warnings.join("\n");
    expect(serializedWarnings).not.toContain("첫 줄 메시지");
    expect(serializedWarnings).toMatch(/멀티라인.*1건/);
  });
});
