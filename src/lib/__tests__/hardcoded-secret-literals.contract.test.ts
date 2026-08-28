// 하드코딩 시크릿 리터럴 계약 테스트 (P0 공개 레포 데이터 가드, 2026-07-23).
//
// 배경: 채널정보 라우트가 `process.env.RAPIDAPI_KEY || "<실키>"` 형태로 **운영에서 쓰는 그
// 키 자체**를 소스에 폴백으로 박아두고 있었다. 레포는 현재 PRIVATE 이나 공개 이력이 있어
// 커밋에 남은 키는 이미 노출된 것으로 취급해야 하고, RapidAPI 키는 API 단위가 아니라
// **계정 단위**라 노출 범위가 그 계정이 구독한 모든 API 로 번진다.
//
// 이 테스트는 두 가지를 막는다.
//   (1) env 폴백 리터럴  — `process.env.X || "…"` / `?? "…"` 의 값이 시크릿처럼 생긴 경우
//   (2) 시크릿 이름 상수 — KEY/SECRET/TOKEN/PASSWORD 계열 식별자에 긴 리터럴 직접 대입
// 선례: instagram-scrape-callers(화이트리스트 등록 강제) · RESERVED_PORTAL_SLUGS.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// wag-heartbeat 는 Worker 배포체라 루트 tsconfig 밖이지만, 시크릿 리터럴 스캔은
// 배포 경로와 무관하게 필요하다(ygrd-link 가 이 사각에 있던 것과 같은 부류).
const SCAN_DIRS = ["src", "scripts", "wag-heartbeat"];

// 시크릿 판정 임계값. 낮추면 오탐(테스트 픽스처·해시·CSS 값)이 늘고, 높이면 짧은 키를
// 놓친다. 20자·영숫자 혼합은 실사고 키(50자)와 기본 암호화 키(44자)를 모두 잡으면서
// 레포의 정상 폴백(`""` · `"mock"` · `"7"` · `"와이그라운드"`)은 통과시키는 지점이다.
const MIN_SECRET_LENGTH = 20;
// 문맥이 이미 시크릿을 자백한 경우(식별자·env 이름에 KEY/SECRET/TOKEN)는 더 짧아도 잡는다.
const MIN_LENIENT_SECRET_LENGTH = 12;

// 길지만 시크릿이 아닌 값 — 사유를 붙여 등록한다.
const BENIGN_LITERALS = new Set<string>([
  "replace-with-32-byte-secret", // .env.example 자리표시자 문구와 동일한 계열
  "abcdefghjkmnpqrstuvwxyz23456789", // portal-auth: 비밀번호 생성용 문자 집합(값이 아니라 알파벳)
  "test_cron_secret_token_123", // scripts/verify-cron: 401 확인용 가짜 토큰(진짜 시크릿 아님)
]);

// 알려진 예외 — 제거가 별건으로 분리된 항목만 등재한다. 항목이 해소되면 줄을 지운다.
// ⚠️ 새 시크릿을 여기에 추가해 테스트를 통과시키지 말 것. 이 목록은 "정리 대기"지
//    "허용"이 아니다.
// 2026-07-23 기준 비어 있다 — `src/lib/encryption.ts` 예외는 fail-closed 전환 +
// 재암호화 스크립트(`scripts/reencrypt-resident-numbers.ts`)로 해소돼 제거했다.
const PENDING_EXCEPTIONS = new Map<string, string>([]);

const SECRET_WORD = "KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL";
const SECRET_NAME_RE = new RegExp(SECRET_WORD, "i");

// `process.env.X || "…"` / `?? "…"` — 그룹 1=env 이름, 3=리터럴
const ENV_FALLBACK = /process\.env\.([A-Za-z0-9_]+)(?:\s*(?:\|\||\?\?)\s*process\.env\.[A-Za-z0-9_]+)*\s*(?:\|\||\?\?)\s*(["'`])([^"'`\n]*)\2/g;
// `const API_KEY = "…"` — 식별자 이름이 시크릿을 자백하는 경우
const SECRET_NAMED_CONST = new RegExp(`\\b[A-Za-z_]*(?:${SECRET_WORD})[A-Za-z_]*\\s*[:=]\\s*(["'\`])([^"'\`\\n]*)\\1`, "gi");
// `env("ASSET_TOKEN_ENCRYPTION_KEY") ?? "…"` — 헬퍼 경유 조회. 2026-07-23 실사고:
// `process.env.` 직접 접근만 보던 초판이 이 형태를 통째로 놓쳤다.
const ENV_HELPER_FALLBACK = new RegExp(`\\benv\\(\\s*["'\`]([A-Za-z0-9_]*(?:${SECRET_WORD})[A-Za-z0-9_]*)["'\`]\\s*\\)\\s*(?:\\|\\||\\?\\?)\\s*(["'\`])([^"'\`\\n]*)\\2`, "gi");

/**
 * 시크릿처럼 생겼는가 — 충분히 길고 공백이 없는 값.
 *
 * `lenient` 는 **주변 문맥이 이미 시크릿임을 자백한 경우**(식별자·env 이름에
 * KEY/SECRET/TOKEN 이 박힌 경우)에 쓴다. 그때는 숫자 포함 조건을 뺀다 — 실사고
 * `"wag-crm-dev-token-key"` 처럼 **숫자가 하나도 없는 시크릿 폴백**이 실재하고,
 * 문맥이 확실하므로 오탐 위험이 낮다. 반대로 문맥이 없는 일반 리터럴에까지 이
 * 완화를 적용하면 흔한 슬러그·클래스명이 대량 오탐된다.
 */
function looksLikeSecret(value: string, lenient = false): boolean {
  if (BENIGN_LITERALS.has(value)) return false;
  if (value.length < (lenient ? MIN_LENIENT_SECRET_LENGTH : MIN_SECRET_LENGTH)) return false;
  if (/\s/.test(value)) return false; // 사람이 읽는 문구(에러 메시지·안내문)
  if (!/[A-Za-z]/.test(value)) return false;
  if (!lenient && !/[0-9]/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false; // URL(redis:// 등 포함)은 별도 관심사
  if (value.includes("${")) return false; // 보간 템플릿 = 런타임 생성값이지 고정 시크릿이 아니다
  return true;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 테스트 픽스처는 가짜 시크릿을 정당하게 담는다 — 기존 계약 테스트와 같은 제외 규칙.
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findSecretLiterals(source: string): string[] {
  const hits: string[] = [];
  // 값은 앞 4자만 남겨 보고한다 — 실패 로그가 시크릿 유출 경로가 되지 않도록(P0).
  const record = (v: string) => hits.push(`${v.slice(0, 4)}…(${v.length}자)`);

  // env 폴백: 그룹 1=env 이름, 3=리터럴. **env 이름**이 시크릿을 자백할 때만 완화.
  // 식별자 이름으로 완화를 넓히면 STORAGE_KEY·CACHE_KEY 류가 대량 오탐된다(실측).
  ENV_FALLBACK.lastIndex = 0;
  for (const m of source.matchAll(ENV_FALLBACK)) {
    if (looksLikeSecret(m[3], SECRET_NAME_RE.test(m[1]))) record(m[3]);
  }
  // 헬퍼 경유 env 폴백: 그룹 1=env 이름(정규식이 이미 시크릿 이름만 매칭), 3=리터럴.
  ENV_HELPER_FALLBACK.lastIndex = 0;
  for (const m of source.matchAll(ENV_HELPER_FALLBACK)) {
    if (looksLikeSecret(m[3], true)) record(m[3]);
  }
  // 시크릿 이름 상수: 완화하지 않는다(위 오탐 사유).
  SECRET_NAMED_CONST.lastIndex = 0;
  for (const m of source.matchAll(SECRET_NAMED_CONST)) {
    if (looksLikeSecret(m[2])) record(m[2]);
  }
  return hits;
}

describe("하드코딩 시크릿 리터럴 계약", () => {
  const files = SCAN_DIRS.flatMap((d) => listSourceFiles(join(process.cwd(), d)));

  it("src·scripts 전체를 스캔한다(스캐너 자체 회귀 가드)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("env 폴백·시크릿 상수에 시크릿처럼 생긴 리터럴이 없다", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      if (PENDING_EXCEPTIONS.has(rel)) continue;
      // 값은 앞 4자만 남겨 보고한다 — 실패 로그가 시크릿 유출 경로가 되지 않도록(P0).
      for (const hit of findSecretLiterals(readFileSync(file, "utf8"))) {
        violations.push(`${rel} → ${hit}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("스캐너가 실제 유출 패턴을 잡는다(음성 대조군)", () => {
    // 실사고 형태(50자 RapidAPI 키)를 모사한 합성 문자열 — 실키가 아니다.
    const synthetic = "a".repeat(20) + "1234567890" + "b".repeat(20);
    expect(findSecretLiterals(`const k = process.env.SOME_KEY || "${synthetic}";`)).toHaveLength(1);
    expect(findSecretLiterals(`const API_TOKEN = "${synthetic}";`)).toHaveLength(1);
    // 정상 폴백은 통과해야 한다.
    expect(findSecretLiterals(`const m = process.env.X_COLLECT_MODE || "mock";`)).toEqual([]);
    expect(findSecretLiterals(`const u = process.env.SMTP_USER || '';`)).toEqual([]);
    expect(findSecretLiterals(`const n = process.env.SMTP_FROM_NAME || '와이그라운드';`)).toEqual([]);
  });

  it("정리 대기 예외는 실존 파일만 담는다(해소 시 목록 청소 강제)", () => {
    for (const rel of PENDING_EXCEPTIONS.keys()) {
      expect(existsSync(join(process.cwd(), rel)), rel).toBe(true);
      // 예외가 더 이상 필요 없어졌는데 목록에 남아 있으면 알려준다.
      const stillViolating = findSecretLiterals(readFileSync(join(process.cwd(), rel), "utf8"));
      expect(stillViolating.length, `${rel}: 위반이 사라졌다 — PENDING_EXCEPTIONS 에서 제거할 것`).toBeGreaterThan(0);
    }
  });
});
