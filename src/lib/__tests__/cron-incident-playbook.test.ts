import { describe, expect, it } from "vitest";
import type { CronErrorKind } from "../cron-error-kind";
import { matchPlaybook, isProxyJob, type PlaybookMatch } from "../cron-incident-playbook";

type In = Parameters<typeof matchPlaybook>[0];
const a = (lastMessage: string, errorKind: CronErrorKind | null = "unknown", jobKey = "collect-instagram"): In => ({
  jobKey,
  kind: "A",
  errorKind,
  lastMessage,
});

// 플레이북 표(설계 §5.5 확정판)의 문장 — 오너 화면·알림에 그대로 나간다. 한 글자도 바꾸지 않는다.
const PROXY_ACTION =
  "프록시 월 한도가 바닥났습니다. 운영 서버 설정의 프록시 목록 맨 앞에 여유 있는 계정을 넣고 서버를 다시 시작해 주세요.";
const IG_ACTION =
  "인스타그램 접근 토큰이 만료됐습니다. Meta 개발자 화면에서 토큰을 다시 발급해 운영 서버 설정에 넣어 주세요.";
const GEMINI_ACTION =
  "Gemini 사용 한도에 걸린 것으로 보입니다. Google AI Studio 에서 월 지출 한도와 사용량을 확인해 주세요.";
const FORMAT_ACTION =
  "수집하는 외부 사이트의 화면 구조가 바뀐 것으로 보입니다. 수집 코드 수정이 필요해 조사 작업을 열어 주세요.";
const CAPTCHA_ACTION = "외부 사이트가 자동 접근을 막고 있습니다. 수집 경로를 바꿀지 판단이 필요합니다.";
const DB_ACTION =
  "데이터베이스 접속 정보가 맞지 않습니다. 운영 서버 설정의 데이터베이스 주소와 비밀번호를 확인해 주세요.";

describe("matchPlaybook — 표의 행마다 맞는 예·안 맞는 예", () => {
  it("proxy-quota: 종류가 프록시 한도면 확정", () => {
    expect(matchPlaybook(a("fetch failed <- Proxy response (407)", "proxy_quota", "naver-order-sync"))).toEqual({
      id: "proxy-quota",
      cause: "프록시 월 한도 소진",
      confidence: "확정",
      ownerAction: PROXY_ACTION,
    });
  });

  it("proxy-quota: 프록시 작업 + 장부 전부 실패면 일시 장애 문구여도 확정", () => {
    const m = matchPlaybook({ ...a("fetch failed", "network", "naver-order-sync"), proxyLedgerAllFailed: true });
    expect(m?.id).toBe("proxy-quota");
    expect(m?.confidence).toBe("확정");
  });

  it("proxy-quota: 프록시를 안 쓰는 작업은 장부 신호를 무시한다", () => {
    expect(matchPlaybook({ ...a("fetch failed", "network", "capture-stories"), proxyLedgerAllFailed: true })).toBeNull();
  });

  it("proxy-quota: 장부 신호가 없으면 일시 장애는 안 맞는다", () => {
    expect(matchPlaybook(a("fetch failed", "network", "naver-order-sync"))).toBeNull();
    expect(matchPlaybook({ ...a("fetch failed", "network", "naver-order-sync"), proxyLedgerAllFailed: false })).toBeNull();
  });

  it.each([
    "토큰 갱신 실패: Error validating access token (code 190)",
    'Graph error {"code": 190, "message": "expired"}',
    'Graph error {"code":190}',
    "토큰 교환 실패: HTTP 400",
  ])("ig-token: %s → 확정", (msg) => {
    expect(matchPlaybook(a(msg, "auth"))).toEqual({
      id: "ig-token",
      cause: "인스타그램 접근 토큰 만료",
      confidence: "확정",
      ownerAction: IG_ACTION,
    });
  });

  it("ig-token: 다른 코드 번호는 안 맞는다", () => {
    expect(matchPlaybook(a("Graph error (code 1900)", "unknown"))).toBeNull();
    expect(matchPlaybook(a('{"code":19}', "unknown"))).toBeNull();
  });

  it.each([
    "429 RESOURCE_EXHAUSTED",
    "Gemini status=429 spending cap exceeded",
    "Gemini status=429 Quota exceeded for metric",
  ])("gemini-cap: %s → 후보", (msg) => {
    expect(matchPlaybook(a(msg, "rate_limit", "analyze-voc"))).toEqual({
      id: "gemini-cap",
      cause: "Gemini 사용 한도 도달",
      confidence: "후보",
      ownerAction: GEMINI_ACTION,
    });
  });

  it("gemini-cap: 한도 문구 없는 429(네이버 등)는 안 맞는다", () => {
    expect(matchPlaybook(a("네이버 API status=429 Too Many Requests", "rate_limit", "naver-order-sync"))).toBeNull();
    expect(matchPlaybook(a("quota 안내 메일 수신", "unknown"))).toBeNull();
  });

  it.each(["스토리 응답 형식 불일치", "스토리 응답 미포착(감시 패턴 불일치)", "감시 패턴 불일치", "검색 결과 미렌더"])(
    "response-format: %s → 후보",
    (msg) => {
      expect(matchPlaybook(a(msg, "unknown", "capture-stories"))).toEqual({
        id: "response-format",
        cause: "외부 사이트 화면 구조가 바뀜",
        confidence: "후보",
        ownerAction: FORMAT_ACTION,
      });
    },
  );

  it.each(["CAPTCHA_REQUIRED", "upstream status=422 Unprocessable"])("captcha: %s → 후보", (msg) => {
    expect(matchPlaybook(a(msg, "unknown"))).toEqual({
      id: "captcha",
      cause: "외부 사이트가 자동 접근을 막음",
      confidence: "후보",
      ownerAction: CAPTCHA_ACTION,
    });
  });

  it("captcha: 422건 같은 건수는 안 맞는다", () => {
    expect(matchPlaybook(a("대상 422건 처리", "unknown"))).toBeNull();
  });

  it("db-auth: Prisma DB 인증 실패 → 확정", () => {
    expect(
      matchPlaybook(a("Authentication failed against database server at 127.0.0.1", "config", "naver-order-sync")),
    ).toEqual({
      id: "db-auth",
      cause: "데이터베이스 접속 정보 불일치",
      confidence: "확정",
      ownerAction: DB_ACTION,
    });
  });

  it("env-missing: 설정 종류 + 키 이름 하나", () => {
    expect(matchPlaybook(a("GEMINI_API_KEY 가 설정되지 않았습니다", "config", "analyze-voc"))).toEqual({
      id: "env-missing",
      cause: "설정값 누락: GEMINI_API_KEY",
      confidence: "확정",
      ownerAction: "운영 서버 설정에 GEMINI_API_KEY 값이 비어 있습니다. 값을 넣고 서버를 다시 시작해 주세요.",
    });
  });

  it("env-missing: 키 이름은 겹치지 않게 최대 2개", () => {
    const m = matchPlaybook(
      a("INSTAGRAM_ACCESS_TOKEN·INSTAGRAM_ACCOUNT_ID 미설정 (INSTAGRAM_ACCESS_TOKEN, THIRD_KEY)", "config"),
    );
    expect(m?.cause).toBe("설정값 누락: INSTAGRAM_ACCESS_TOKEN·INSTAGRAM_ACCOUNT_ID");
    expect(m?.ownerAction).toBe(
      "운영 서버 설정에 INSTAGRAM_ACCESS_TOKEN·INSTAGRAM_ACCOUNT_ID 값이 비어 있습니다. 값을 넣고 서버를 다시 시작해 주세요.",
    );
  });

  it("env-missing: 키 이름이 없거나 설정 종류가 아니면 안 맞는다", () => {
    expect(matchPlaybook(a("인스타 토큰/계정ID 미설정", "config"))).toBeNull();
    expect(matchPlaybook(a("GEMINI_API_KEY 관련 오류", "unknown"))).toBeNull();
  });

  it("encryption-key: 감사 작업 + 열리지 않는 행 N건 → 확정, 건수만 싣는다", () => {
    const msg =
      "주민등록번호가 현재 ENCRYPTION_KEY 로 열리지 않는다. 현재·구 키 어느 쪽으로도 열리지 않는 행 3건 / 저장 40건 중. 구 키를 회수할 수 있으면 …";
    expect(matchPlaybook(a(msg, "unknown", "encryption-key-audit"))).toEqual({
      id: "encryption-key",
      cause: "암호화 키로 열리지 않는 주민등록번호 3건",
      confidence: "확정",
      ownerAction:
        "현재 암호화 키로 열리지 않는 주민등록번호가 3건 있습니다. 구 키를 찾을 수 있으면 키 교체 절차대로 다시 암호화하고, 없으면 해당 셀러의 주민등록번호를 다시 입력해 주세요.",
    });
  });

  it("encryption-key: 다른 작업이거나 구 키로만 열리는 경우는 안 맞는다", () => {
    expect(matchPlaybook(a("열리지 않는 행 3건", "unknown", "naver-order-sync"))).toBeNull();
    expect(
      matchPlaybook(a("구 키로만 열리는 행 2건(재암호화 미완) / 저장 40건 중", "unknown", "encryption-key-audit")),
    ).toBeNull();
  });

  it("A 가 아닌 사고·빈 메시지는 플레이북을 쓰지 않는다", () => {
    expect(matchPlaybook({ ...a("토큰 교환 실패", "auth"), kind: "B" })).toBeNull();
    expect(matchPlaybook({ ...a("", "auth"), lastMessage: null })).toBeNull();
    expect(matchPlaybook(a("대상 5건 전량 실패(성공 0)", "unknown"))).toBeNull();
  });

  it("표 순서대로 처음 맞는 것이 이긴다(프록시 한도 > 토큰 만료)", () => {
    expect(matchPlaybook(a("Proxy response (407) … (code 190)", "proxy_quota", "collect-instagram"))?.id).toBe(
      "proxy-quota",
    );
  });

  it("대표 원인이 붙은 전량 실패 문구에서도 맞는다(1번 작업 형식)", () => {
    expect(
      matchPlaybook(a("대상 4건 전량 실패(성공 0) — 대표 원인: Graph error (code 190)", "auth"))?.id,
    ).toBe("ig-token");
  });
});

describe("isProxyJob", () => {
  it("프록시를 쓰는 작업만 참", () => {
    for (const k of ["naver-order-sync", "naver-settlement-sync", "collect-qnas", "collect-instagram", "enrich-references", "enrich-inbox"]) {
      expect(isProxyJob(k)).toBe(true);
    }
    expect(isProxyJob("capture-stories")).toBe(false);
    expect(isProxyJob("analyze-voc")).toBe(false);
  });
});

describe("계약: 오너 문장에 원문이 끼지 않는다(⚙️L3)", () => {
  const SENTINEL = "seller_a zq9secret";
  const samples: In[] = [
    a(`Proxy response (407) ${SENTINEL}`, "proxy_quota", "naver-order-sync"),
    { ...a(`fetch failed ${SENTINEL}`, "network", "naver-settlement-sync"), proxyLedgerAllFailed: true },
    a(`(code 190) ${SENTINEL}`, "auth"),
    a(`토큰 교환 실패 ${SENTINEL}`, "auth"),
    a(`RESOURCE_EXHAUSTED ${SENTINEL}`, "rate_limit"),
    a(`응답 형식 불일치 ${SENTINEL}`, "unknown"),
    a(`CAPTCHA_REQUIRED ${SENTINEL}`, "unknown"),
    a(`Authentication failed against database server ${SENTINEL}`, "config"),
    a(`NAVER_CLIENT_SECRET 미설정 ${SENTINEL} 12345`, "config"),
    a(`열리지 않는 행 7건 ${SENTINEL}`, "unknown", "encryption-key-audit"),
  ];

  // 키 이름(대문자_밑줄)과 정수를 자리표로 바꾸면 남는 것은 고정 문장뿐이어야 한다.
  const TEMPLATES = new Set([
    "프록시 월 한도 소진",
    PROXY_ACTION,
    "인스타그램 접근 토큰 만료",
    IG_ACTION,
    "Gemini 사용 한도 도달",
    GEMINI_ACTION,
    "외부 사이트 화면 구조가 바뀜",
    FORMAT_ACTION,
    "외부 사이트가 자동 접근을 막음",
    CAPTCHA_ACTION,
    "데이터베이스 접속 정보 불일치",
    DB_ACTION,
    "설정값 누락: <키>",
    "운영 서버 설정에 <키> 값이 비어 있습니다. 값을 넣고 서버를 다시 시작해 주세요.",
    "암호화 키로 열리지 않는 주민등록번호 <N>건",
    "현재 암호화 키로 열리지 않는 주민등록번호가 <N>건 있습니다. 구 키를 찾을 수 있으면 키 교체 절차대로 다시 암호화하고, 없으면 해당 셀러의 주민등록번호를 다시 입력해 주세요.",
  ]);
  const toTemplate = (s: string) =>
    s.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:·[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)*\b/g, "<키>").replace(/\d+/g, "<N>");

  it.each(samples.map((s) => [s.lastMessage, s] as const))("%s", (_msg, input) => {
    const m = matchPlaybook(input) as PlaybookMatch;
    expect(m).not.toBeNull();
    for (const text of [m.cause, m.ownerAction]) {
      expect(text).not.toContain("seller_a");
      expect(text).not.toContain("zq9secret");
      expect(TEMPLATES.has(toTemplate(text))).toBe(true);
    }
  });
});
