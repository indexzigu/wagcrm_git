import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * 메일 서버 좌표는 `mail-config.ts` **한 곳**에만 있어야 한다.
 *
 * **왜 계약인가:** 세 소비처가 같은 계정 자격증명(`SMTP_USER`/`SMTP_PASS`)을 공유하는데
 * 호스트만 각자 리터럴로 박혀 있었다. 그 상태에서 계정을 옮기면 고쳐야 할 곳이 세 군데인데,
 * 한 곳을 빠뜨려도 **타입도 테스트도 아무것도 잡지 못한다** — 그 기능만 옛 서버에 새 계정
 * 자격증명으로 붙어 인증 실패로 죽는다. 2026-09-01 다음메일→구글 전환에서 실제로 걸릴 뻔했다.
 */

const CONSUMERS = [
  "src/lib/tax-invoice-mail/mail-scan.ts",
  "src/app/order-converter/api/fetch-emails/route.ts",
  "src/app/order-converter/api/send-email/route.ts",
] as const;

const SSOT = "src/lib/mail-config.ts";

/**
 * 주석을 걷어낸 실행 코드만 본다.
 * 이 트랙의 문서가 옛 서버 이름과 새 서버 이름을 **설명하기 위해** 인용하므로, 원문 그대로
 * 스캔하면 자기 주석에 걸려 영구히 빨간불이 된다(레포 선례 다수).
 */
function executableSource(relativePath: string): string {
  const raw = readFileSync(join(process.cwd(), relativePath), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * `imap.<something>.<tld>` · `smtp.<something>.<tld>` 형태의 메일 서버 호스트.
 * ⚠️ `g` 플래그를 쓰지 않는다 — `RegExp.test` 는 `lastIndex` 를 들고 다녀서 전수 스캔 중
 * **한 파일 걸러 한 번씩 거짓 음성**이 난다(공유 정규식 + `g` 의 고전적 함정).
 */
const MAIL_HOST_LITERAL = /\b(?:imap|smtp)\.[a-z0-9-]+(?:\.[a-z]{2,})+\b/i;

/** `src` 아래 타입스크립트 소스 전수(레포 관행: 셸이 아니라 readdirSync 재귀). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

describe("메일 서버 좌표 단일화", () => {
  it.each(CONSUMERS)("%s 에 메일 서버 호스트를 직접 적지 않는다", (path) => {
    expect(executableSource(path)).not.toMatch(MAIL_HOST_LITERAL);
  });

  it.each(CONSUMERS)("%s 는 mail-config 에서 접속 설정을 받아 온다", (path) => {
    expect(executableSource(path)).toMatch(/from ['"]@\/lib\/mail-config['"]/);
  });

  it("SSOT 자신은 호스트를 갖는다 — 스캐너가 고장 나면 이 단언이 먼저 깨진다", () => {
    // 양성 프로브. 위 세 단언은 「없음」을 확인하므로, 정규식이 아무것도 못 잡게 망가져도
    // 조용히 통과한다. 실제로 잡히는 문자열이 있는 파일 하나를 대조군으로 둔다.
    expect(executableSource(SSOT)).toMatch(MAIL_HOST_LITERAL);
  });

  it("소비처에는 옛 메일 사업자 좌표가 남아 있지 않다", () => {
    for (const path of CONSUMERS) {
      expect(executableSource(path)).not.toMatch(/daum\.net/i);
    }
  });

  it("src 어디에도 SSOT 밖의 메일 서버 좌표가 없다 — 네 번째 소비처가 스캔 밖으로 새지 않는다", () => {
    // 🪤 손으로 적은 소비처 목록은 **새 소비처를 조용히 비켜간다**(레포 선례: 크론 인증
    //    사본 18개 중 2개가 그렇게 fail-open 으로 남아 있었다). 그래서 목록이 아니라
    //    **불변식 자체**("SSOT 밖에 메일 호스트 리터럴이 없다")를 src 전수로 확인한다.
    //    ⛔ 「메일 라이브러리를 import 하는 파일」로 파생하지 말 것 — require()·동적 import·
    //       하위 `imap` 직접 사용·다른 발송 라이브러리가 전부 빠져나간다(교차 검증 지적).
    const offenders = sourceFiles("src")
      .filter((path) => path !== SSOT && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => MAIL_HOST_LITERAL.test(executableSource(path)))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("SSOT 는 옛 사업자 폴백을 **유지한다** — 지우면 배포 순서 사고가 되살아난다", () => {
    // 🪤 이 단언은 방향이 반대다(있어야 통과). 옛 사업자 계정이 `.env` 에 남아 있는 동안
    //    구글 상수를 무조건 쓰면, 오너가 계정을 바꾸기 전에 배포가 도는 순간 수신 2경로·
    //    발신 1경로가 **동시에** 인증 실패한다(교차 검증에서 잡힌 P1, 2026-09-01).
    //    "정리"하려는 다음 세션을 여기서 세운다.
    const source = executableSource(SSOT);
    expect(source).toMatch(/imap\.daum\.net/);
    expect(source).toMatch(/smtp\.daum\.net/);
  });
});
