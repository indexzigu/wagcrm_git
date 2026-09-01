import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  GOOGLE_IMAP_HOST,
  GOOGLE_SMTP_HOST,
  IMAP_PORT,
  SMTP_PORT,
  isAllMailbox,
  isOwnSenderAddress,
  isScannableMailbox,
  orderMailboxesForScan,
  resolveImapConfig,
  resolveMailCredentials,
  resolveMailFrom,
  resolveSmtpConfig,
} from "./mail-config";

const MAIL_ENV_KEYS = [
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM_EMAIL",
  "SMTP_FROM_NAME",
  "MAIL_IMAP_HOST",
  "MAIL_SMTP_HOST",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(MAIL_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of MAIL_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of MAIL_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const CREDS = { user: "test@gmail.com", password: "p" };
const LEGACY_CREDS = { user: "test@daum.net", password: "p" };

describe("자격증명", () => {
  it("둘 다 있으면 돌려준다", () => {
    process.env.SMTP_USER = "test@gmail.com";
    process.env.SMTP_PASS = "p";
    expect(resolveMailCredentials()).toEqual({ user: "test@gmail.com", password: "p" });
  });

  it("한쪽만 있으면 null 이다 — 빈 비밀번호로 접속을 시도하지 않는다", () => {
    process.env.SMTP_USER = "test@gmail.com";
    expect(resolveMailCredentials()).toBeNull();
  });

  it("빈 문자열은 미설정과 같다", () => {
    process.env.SMTP_USER = "test@gmail.com";
    process.env.SMTP_PASS = "";
    expect(resolveMailCredentials()).toBeNull();
  });
});

describe("접속 설정 — 서버가 계정을 따라간다", () => {
  it("구글 계정이면 구글 서버로 간다", () => {
    expect(resolveImapConfig(CREDS).host).toBe(GOOGLE_IMAP_HOST);
    expect(resolveSmtpConfig(CREDS).host).toBe(GOOGLE_SMTP_HOST);
  });

  it("옛 사업자 계정이 남아 있으면 옛 서버로 간다 — 배포와 .env 교체 사이의 창을 없앤다", () => {
    // 🪤 이 두 줄이 회귀의 본체다. 구글 상수를 무조건 쓰면, 오너가 .env 를 바꾸기 전에
    //    배포가 돌 때 옛 자격증명이 구글로 가서 수신 2경로·발신 1경로가 동시에 죽는다.
    expect(resolveImapConfig(LEGACY_CREDS).host).toBe("imap.daum.net");
    expect(resolveSmtpConfig(LEGACY_CREDS).host).toBe("smtp.daum.net");
  });

  it("한메일 주소도 같은 사업자로 본다", () => {
    expect(resolveImapConfig({ user: "test@hanmail.net", password: "p" }).host).toBe(
      "imap.daum.net",
    );
  });

  it("자체 도메인 계정(구글 Workspace)은 구글로 간다", () => {
    expect(resolveImapConfig({ user: "info@ygrd.kr", password: "p" }).host).toBe(
      GOOGLE_IMAP_HOST,
    );
  });

  it("env 명시가 계정 판정을 이긴다", () => {
    process.env.MAIL_IMAP_HOST = "imap.example.test";
    process.env.MAIL_SMTP_HOST = "smtp.example.test";
    expect(resolveImapConfig(LEGACY_CREDS).host).toBe("imap.example.test");
    expect(resolveSmtpConfig(LEGACY_CREDS).host).toBe("smtp.example.test");
  });

  it("포트는 두 사업자가 같아서 상수다", () => {
    expect(resolveImapConfig(CREDS).port).toBe(IMAP_PORT);
    expect(resolveSmtpConfig(CREDS).port).toBe(SMTP_PORT);
    expect(resolveSmtpConfig(CREDS).secure).toBe(true);
  });

  it("SNI(servername)를 호스트와 같은 값으로 싣는다 — 없으면 구글 IMAP 이 통째로 죽는다", () => {
    // 🔴 node-imap 은 소켓을 먼저 열고 tls.connect({host, socket}) 에 넘기는데, 소켓을
    //    넘기면 Node 가 host 에서 SNI 를 유추하지 않는다. SNI 가 없으면 구글이 다른
    //    인증서를 내줘 self-signed certificate 로 끊긴다(2026-09-02 실측).
    //    다음메일은 SNI 없이도 붙어서 이 결함이 전환 전까지 드러나지 않았다.
    const google = resolveImapConfig(CREDS);
    expect(google.tlsOptions.servername).toBe(google.host);
    expect(google.tlsOptions.servername).toBe(GOOGLE_IMAP_HOST);

    const legacy = resolveImapConfig(LEGACY_CREDS);
    expect(legacy.tlsOptions.servername).toBe(legacy.host);
  });

  it("env 로 서버를 바꾸면 SNI 도 따라간다", () => {
    process.env.MAIL_IMAP_HOST = "imap.example.test";
    const cfg = resolveImapConfig(CREDS);
    expect(cfg.tlsOptions.servername).toBe("imap.example.test");
  });

  it("authTimeout 은 호출부가 정하고 기본값이 있다", () => {
    expect(resolveImapConfig(CREDS).authTimeout).toBe(10_000);
    expect(resolveImapConfig(CREDS, { authTimeout: 5_000 }).authTimeout).toBe(5_000);
  });
});

describe("발신인", () => {
  it("미설정이면 로그인 계정으로 떨어진다", () => {
    expect(resolveMailFrom({ user: "login@example.com", password: "p" })).toEqual({
      name: "와이그라운드",
      email: "login@example.com",
    });
  });

  it("설정된 주소가 이긴다", () => {
    process.env.SMTP_FROM_EMAIL = "info@example.com";
    process.env.SMTP_FROM_NAME = "다른이름";
    expect(resolveMailFrom({ user: "login@example.com", password: "p" })).toEqual({
      name: "다른이름",
      email: "info@example.com",
    });
  });
});

describe("편지함 제외 — 특수용도 속성이 1차 판정", () => {
  it("이름이 낯설어도 속성으로 거른다", () => {
    expect(isScannableMailbox({ name: "Papelera", attribs: ["\\Trash"] })).toBe(false);
    expect(isScannableMailbox({ name: "Enviados", attribs: ["\\Sent"] })).toBe(false);
  });

  it("선택 불가 컨테이너를 대상에 넣지 않는다(열면 예외가 난다)", () => {
    expect(isScannableMailbox({ name: "[Gmail]", attribs: ["\\Noselect"] })).toBe(false);
  });

  it("사용자 라벨은 통과한다", () => {
    expect(isScannableMailbox({ name: "세금계산서", attribs: [] })).toBe(true);
    expect(isScannableMailbox({ name: "INBOX", attribs: [] })).toBe(true);
  });
});

describe("편지함 제외 — 이름 폴백(속성을 안 주는 서버)", () => {
  it("구글의 붙여쓴 한국어 폴더명을 거른다", () => {
    // 🪤 이 네 줄이 회귀의 본체다 — 종전 목록은 띄어쓴 다음메일 이름만 알고 있었다.
    expect(isScannableMailbox({ name: "[Gmail]/휴지통" })).toBe(false);
    expect(isScannableMailbox({ name: "[Gmail]/보낸편지함" })).toBe(false);
    expect(isScannableMailbox({ name: "[Gmail]/임시보관함" })).toBe(false);
    expect(isScannableMailbox({ name: "[Gmail]/스팸함" })).toBe(false);
  });

  it("다음메일의 띄어쓴 이름도 계속 거른다(서버를 옮겨도 옛 규칙이 살아 있다)", () => {
    expect(isScannableMailbox({ name: "지운 편지함" })).toBe(false);
    expect(isScannableMailbox({ name: "보낸 편지함" })).toBe(false);
    expect(isScannableMailbox({ name: "임시 보관함" })).toBe(false);
  });

  it("영문 이름도 대소문자 무관하게 거른다", () => {
    expect(isScannableMailbox({ name: "Deleted Messages" })).toBe(false);
    expect(isScannableMailbox({ name: "SENT" })).toBe(false);
  });
});

describe("자모 분리(NFD) 이름", () => {
  it("구글이 NFD 로 돌려주는 한국어 편지함도 이름 폴백이 거른다", () => {
    // 특수용도 속성이 없는 서버에서는 이름 판정이 유일한 방어선인데, NFC 로만 비교하면
    // 아래가 전부 통과해 버린다(실측: 구글은 NFD 로 준다).
    expect(isScannableMailbox({ name: "[Gmail]/휴지통" })).toBe(false);
    expect(isScannableMailbox({ name: "[Gmail]/보낸편지함" })).toBe(false);
  });

  it("NFD 전체보관함도 알아본다", () => {
    expect(isAllMailbox({ name: "[Gmail]/전체보관함" })).toBe(true);
  });
});

describe("전체보관함", () => {
  it("속성과 이름 어느 쪽으로도 알아본다", () => {
    expect(isAllMailbox({ name: "[Gmail]/All Mail", attribs: ["\\All"] })).toBe(true);
    expect(isAllMailbox({ name: "[Gmail]/전체보관함" })).toBe(true);
  });

  it("제외하지 않는다 — 보관된 회신이 여기에만 남기 때문이다", () => {
    expect(isScannableMailbox({ name: "[Gmail]/전체보관함", attribs: ["\\All"] })).toBe(true);
  });

  it("사용자 라벨은 전체보관함이 아니다", () => {
    expect(isAllMailbox({ name: "세금계산서" })).toBe(false);
  });
});

describe("순회 차례", () => {
  const GMAIL_BOXES: { name: string; attribs?: string[] }[] = [
    { name: "[Gmail]", attribs: ["\\Noselect"] },
    { name: "[Gmail]/전체보관함", attribs: ["\\All"] },
    { name: "[Gmail]/휴지통", attribs: ["\\Trash"] },
    { name: "[Gmail]/보낸편지함", attribs: ["\\Sent"] },
    { name: "세금계산서", attribs: [] },
    { name: "INBOX", attribs: [] },
  ];

  it("받은편지함 → 사용자 라벨 → 전체보관함 순이다", () => {
    expect(orderMailboxesForScan(GMAIL_BOXES)).toEqual([
      "INBOX",
      "세금계산서",
      "[Gmail]/전체보관함",
    ]);
  });

  it("전체보관함은 항상 맨 마지막이다 — 앞에서 찾으면 비용이 0 이다", () => {
    const ordered = orderMailboxesForScan(GMAIL_BOXES);
    expect(ordered[ordered.length - 1]).toBe("[Gmail]/전체보관함");
  });

  it("전체보관함이 없는 서버에서도 받은편지함이 맨 앞이다", () => {
    expect(orderMailboxesForScan([{ name: "발주" }, { name: "INBOX" }])).toEqual([
      "INBOX",
      "발주",
    ]);
  });
});

describe("자기 발송분 판정", () => {
  it("자사 도메인에서 온 것은 우리 메일이다", () => {
    expect(isOwnSenderAddress("발주 <info@ygrd.kr>", CREDS.user)).toBe(true);
  });

  it("로그인 계정 주소도 우리 메일이다 — 구글이 발신인을 치환한 경우", () => {
    expect(isOwnSenderAddress("test@gmail.com", CREDS.user)).toBe(true);
  });

  it("옛 사업자 계정으로 나간 과거 메일도 우리 메일이다", () => {
    expect(isOwnSenderAddress("nutrione01@example.com", CREDS.user)).toBe(true);
  });

  it("브랜드사 회신은 우리 메일이 아니다", () => {
    expect(isOwnSenderAddress("담당자 <cs@brand.example.com>", CREDS.user)).toBe(false);
  });

  it("우리 주소를 **포함**할 뿐인 거래처 주소를 자기 메일로 걸러내지 않는다", () => {
    // 🪤 부분 일치로 재면 로그인 `test@example.com` 이 거래처 `mytest@example.com` 에
    //    걸려, 첨부가 있는 정상 회신이 「회신 없음」이 된다(교차 검증 P2, 2026-09-01).
    const login = "test@example.com";
    expect(isOwnSenderAddress("mytest@example.com", login)).toBe(false);
    expect(isOwnSenderAddress("공급사 <mytest@example.com>", login)).toBe(false);
    expect(isOwnSenderAddress("공급사 <test@example.com>", login)).toBe(true);
  });

  it("자사 도메인을 흉내 낸 주소는 우리 메일이 아니다", () => {
    // `@ygrd.kr` 을 부분 문자열로 재면 `ygrd.kr.attacker.example.com` 이 통과한다.
    expect(isOwnSenderAddress("cs@ygrd.kr.attacker.example.com", CREDS.user)).toBe(false);
  });

  it("옛 사업자 로컬파트는 **앞자리**로만 인정한다", () => {
    expect(isOwnSenderAddress("notnutrione01@example.com", CREDS.user)).toBe(false);
  });

  it("표시이름 안에 주소가 들어 있어도 **실제 발신 주소**로 판정한다", () => {
    // 🪤 첫 꺾쇠를 집으면 거래처 회신이 자기 발송분으로 걸러진다(RFC 5322 의 addr-spec 은
    //    마지막 angle-addr). P2 와 같은 침묵형 폐기라 같은 자리에서 함께 막는다.
    expect(
      isOwnSenderAddress('"공지 <info@ygrd.kr>" <cs@brand.example.com>', CREDS.user),
    ).toBe(false);
    expect(
      isOwnSenderAddress('"브랜드 <cs@brand.example.com>" <info@ygrd.kr>', CREDS.user),
    ).toBe(true);
  });

  it("꺾쇠 없는 다중 주소도 마지막 것을 본다", () => {
    expect(isOwnSenderAddress("cs@brand.example.com, info@ygrd.kr", CREDS.user)).toBe(true);
    expect(isOwnSenderAddress("info@ygrd.kr, cs@brand.example.com", CREDS.user)).toBe(false);
  });
});

describe("중요·별표 편지함", () => {
  it("받은편지함의 걸러 보기라 스캔 대상이 아니다", () => {
    expect(isScannableMailbox({ name: "[Gmail]/중요편지함", attribs: ["\\Important"] })).toBe(
      false,
    );
    expect(isScannableMailbox({ name: "[Gmail]/별표편지함", attribs: ["\\Flagged"] })).toBe(false);
  });

  it("속성을 안 주는 서버에서도 이름으로 걸린다", () => {
    expect(isScannableMailbox({ name: "[Gmail]/중요편지함" })).toBe(false);
    expect(isScannableMailbox({ name: "Starred" })).toBe(false);
  });
});
