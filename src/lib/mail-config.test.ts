import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_IMAP_HOST,
  DEFAULT_SMTP_HOST,
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
    expect(resolveImapConfig(CREDS).host).toBe(DEFAULT_IMAP_HOST);
    expect(resolveSmtpConfig(CREDS).host).toBe(DEFAULT_SMTP_HOST);
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
      DEFAULT_IMAP_HOST,
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
    expect(isOwnSenderAddress("발주 <info@ygrd.kr>", CREDS)).toBe(true);
  });

  it("로그인 계정 주소도 우리 메일이다 — 구글이 발신인을 치환한 경우", () => {
    expect(isOwnSenderAddress("test@gmail.com", CREDS)).toBe(true);
  });

  it("옛 사업자 계정으로 나간 과거 메일도 우리 메일이다", () => {
    expect(isOwnSenderAddress("nutrione01@example.com", CREDS)).toBe(true);
  });

  it("브랜드사 회신은 우리 메일이 아니다", () => {
    expect(isOwnSenderAddress("담당자 <cs@brand.example.com>", CREDS)).toBe(false);
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
