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
  // 🪤 `//` 앞의 `:` 를 지켜야 한다 — 가드 없이 자르면 `"imaps://imap.gmail.com"` 같은
  //    **URL 형태 설정이 통째로 잘려** 위반이 스캔에서 사라진다(실측). 레포 선례
  //    `ingest-lane.contract.test.ts` 가 같은 이유로 같은 가드를 쓴다.
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * `imap.<something>.<tld>` · `smtp.<something>.<tld>` 형태의 메일 서버 호스트.
 * ⚠️ `g` 플래그를 쓰지 않는다 — `RegExp.test` 는 `lastIndex` 를 들고 다녀서 전수 스캔 중
 * **한 파일 걸러 한 번씩 거짓 음성**이 난다(공유 정규식 + `g` 의 고전적 함정).
 */
const MAIL_HOST_LITERAL = /\b(?:imap|smtp)\.[a-z0-9-]+(?:\.[a-z]{2,})+\b/i;

/** 문자열 리터럴(따옴표 3종). 이스케이프를 건너뛰며 짝을 찾는다. */
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;

/**
 * 메일 서버 호스트를 **문자열 안에서만** 찾는다.
 *
 * 🪤 소스 전체에 정규식을 그냥 돌리면 **속성 체인이 걸린다** — `imap.seq.fetch(…)`
 * (node-imap 실 API) · `cfg.smtp.auth.user` 가 그대로 매치된다(실측). 호스트는 언제나
 * 문자열이므로 리터럴 안으로 좁히면 그 부류가 통째로 사라진다.
 */
function hasMailHostLiteral(source: string): boolean {
  for (const match of source.matchAll(STRING_LITERAL)) {
    if (MAIL_HOST_LITERAL.test(match[0])) return true;
  }
  return false;
}

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
    expect(hasMailHostLiteral(executableSource(path))).toBe(false);
  });

  it.each(CONSUMERS)("%s 는 mail-config 에서 접속 설정을 받아 온다", (path) => {
    expect(executableSource(path)).toMatch(/from ['"]@\/lib\/mail-config['"]/);
  });

  it("SSOT 자신은 호스트를 갖는다 — 스캐너가 고장 나면 이 단언이 먼저 깨진다", () => {
    // 양성 프로브. 위 세 단언은 「없음」을 확인하므로, 정규식이 아무것도 못 잡게 망가져도
    // 조용히 통과한다. 실제로 잡히는 문자열이 있는 파일 하나를 대조군으로 둔다.
    expect(hasMailHostLiteral(executableSource(SSOT))).toBe(true);
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
    //    범위에 `scripts/` 도 넣는다 — 지금은 소비처 0건이지만 운영 스크립트가 메일을
    //    붙이기 시작하면 `src` 만 보는 스캔은 그것을 못 본다(fail-open).
    const offenders = [...sourceFiles("src"), ...sourceFiles("scripts")]
      .filter((path) => path !== SSOT && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => hasMailHostLiteral(executableSource(path)))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("IMAP 에 붙는 파일은 **전부** SSOT 를 거친다", () => {
    // 🔴 `tlsOptions.servername`(SNI) 이 빠지면 구글 IMAP 이 통째로 죽는다(2026-09-02 실측).
    //    소비처가 접속 옵션을 손으로 지으면 그 한 줄이 조용히 빠진다.
    // ⛔ 위 「손으로 적은 목록은 새 소비처를 조용히 비켜간다」가 여기에도 적용된다 —
    //    CONSUMERS 를 돌면서 조기 반환하는 형태로 쓰지 말 것(초판이 그렇게 썼다가
    //    같은 파일 6줄 위의 자기 금지를 어겼다). 전수로 훑고, **검사 건수 하한**을 함께
    //    단언해 「하나도 안 걸러서 초록」인 상태를 구분한다(위 양성 프로브와 같은 규약).
    const connectors = [...sourceFiles("src"), ...sourceFiles("scripts")]
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => /(?:imaps?\.connect|new\s+Imap)\s*\(/.test(executableSource(path)));

    // 양성 프로브: 탐지가 망가지면 목록이 비어 **아무것도 검사하지 않은 채 초록**이 된다.
    // 실제로 IMAP 에 붙는 두 파일이 잡히는지를 먼저 못박는다.
    expect(connectors).toEqual(
      expect.arrayContaining([
        "src/lib/tax-invoice-mail/mail-scan.ts",
        "src/app/order-converter/api/fetch-emails/route.ts",
      ]),
    );

    for (const path of connectors) {
      const source = executableSource(path);
      // 🪤 `resolveImapConfig` 를 **언급**만 하고 실제로는 옵션을 손수 지어 넘길 수 있다.
      //    그래서 connect 에 **무엇이 들어가는지**를 본다: 인자가 객체 리터럴이면 `imap:` 값이
      //    곧 SSOT 호출이어야 하고, 변수면 그 변수 선언이 SSOT 호출을 담아야 한다.
      //    ⛔ 「`port`·`tls` 키가 없다」로 재지 말 것 — 정작 SNI 키 `tlsOptions:` 가 `\btls\s*:`
      //       에 안 걸려 거짓 음성이고, 두 소비처 모두 0건이라 공회전이었다(교차 검증 지적).
      const call = source.match(/imaps?\.connect\(\s*([^)]*)/);
      expect({ path, hasCall: Boolean(call) }).toEqual({ path, hasCall: true });
      const arg = (call?.[1] ?? "").trim();
      const objectForm = /^\{\s*imap\s*:\s*resolveImapConfig\s*\(/.test(arg);
      const identifier = arg.match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
      const viaVariable = Boolean(
        identifier &&
          new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=[^;]*resolveImapConfig\\s*\\(`, "s").test(
            source,
          ),
      );
      expect({ path, fromSsot: objectForm || viaVariable }).toEqual({ path, fromSsot: true });
    }
  });
  it("메일 경로 소스는 NFC 로 커밋된다 — 그래야 우리 리터럴을 감싸지 않아도 된다", () => {
    // 서버가 준 문자열만 `toNfc` 로 맞추고 **우리 상수는 그대로 비교**하는 것이 계약이다.
    // 그 전제가 깨지면(에디터·OS 가 파일을 NFD 로 저장) 비교가 조용히 빗나가므로 여기서 고정한다.
    const paths = [
      SSOT,
      ...CONSUMERS,
      "src/lib/text-normalize.ts",
      "src/lib/order-converter/order-parser.ts",
      "src/lib/tax-invoice-mail/issuance-match.ts",
    ];
    for (const path of paths) {
      const raw = readFileSync(join(process.cwd(), path), "utf8");
      expect({ path, nfc: raw === raw.normalize("NFC") }).toEqual({ path, nfc: true });
    }
  });

  it("SSOT 는 SNI 를 싣는다 — 빠지면 구글 IMAP 이 인증서 오류로 끊긴다", () => {
    // 반대 방향 단언(있어야 통과). 위 단언들은 「없음」만 보므로 이것이 대조군이다.
    // 🪤 `tlsOptions: { servername` 로 재면 **타입 선언에도 걸려** 실제 대입을 지워도
    //    초록이다(변이 테스트로 실측). 반드시 **값이 host 와 묶인 대입**을 본다.
    expect(executableSource(SSOT)).toMatch(/servername:\s*host\b/);
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
