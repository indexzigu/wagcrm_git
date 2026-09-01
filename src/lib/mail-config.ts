/**
 * 메일 서버 접속 정보 SSOT — IMAP 읽기 2경로 + SMTP 발신 1경로가 공유한다.
 *
 * ## 왜 한 곳인가
 *
 * 세 소비처(`tax-invoice-mail/mail-scan.ts` · `order-converter/api/fetch-emails` ·
 * `order-converter/api/send-email`)가 **같은 계정 자격증명**(`SMTP_USER`/`SMTP_PASS`)을
 * 공유하는데 호스트만 각자 리터럴로 박혀 있었다. 그래서 계정을 옮기면 세 곳을 동시에
 * 고쳐야 하고, 한 곳을 빠뜨리면 **그 기능만 옛 서버로 인증을 시도해 조용히 죽는다**
 * (자격증명은 새 계정 것이므로 인증 실패다 — 다음메일→구글 전환에서 실제로 걸릴 뻔했다).
 * 호스트를 여기 모아 두면 "계정을 옮긴다"가 env 한 벌 교체로 끝난다.
 *
 * ## 기본값은 구글이다 (2026-09-01 전환, 오너 결정)
 *
 * `ygrd.kr` 수신은 2026-08-23 에 Cloudflare Email Routing 으로 넘어갔고 지금은
 * Cloudflare 가 받아 Gmail 로 전달한다. 앱이 붙는 메일함도 구글로 통일했다.
 *
 * ⚠️ **구글은 일반 비밀번호로 IMAP·SMTP 를 받지 않는다**(2025-03-14 부로 차단). `SMTP_PASS`
 * 에는 2단계 인증을 켠 계정에서 발급한 **앱 비밀번호**가 들어간다. OAuth 는 메일함 전체
 * 접근(`https://mail.google.com/`)이 제한 범위 스코프라 별도 보안 심사가 필요해 기각했다.
 *
 * ⛔ **자격증명을 이 파일에 리터럴로 두지 말 것**(P0 — 레포 public).
 * `hardcoded-secret-literals.contract.test.ts` 가 강제한다.
 */

/** 구글 메일 수신 서버. env 로 덮을 수 있게 두되 기본값으로 설정 누락을 흡수한다. */
export const DEFAULT_IMAP_HOST = "imap.gmail.com";
export const DEFAULT_IMAP_PORT = 993;
/** 구글 메일 발신 서버(SSL 직결 포트). */
export const DEFAULT_SMTP_HOST = "smtp.gmail.com";
export const DEFAULT_SMTP_PORT = 465;

export interface ImapConnectionConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  tls: true;
  authTimeout: number;
}

export interface SmtpConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

function readPort(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 계정 자격증명. 둘 중 하나라도 비면 `null` — 호출부가 각자 실패를 **드러내야** 한다.
 * ⛔ 빈 문자열로 접속을 시도하지 말 것: 인증 실패가 "메일 0건"으로 보여 오너가 미수취를
 * 못 본다(`selfhost-env-contract.ts` 의 `SMTP_USER` 항목이 이 실패 모드를 적어 둔 곳이다).
 */
export function resolveMailCredentials(): { user: string; password: string } | null {
  const user = process.env.SMTP_USER ?? "";
  const password = process.env.SMTP_PASS ?? "";
  if (!user || !password) return null;
  return { user, password };
}

/** IMAP 접속 설정. `authTimeout` 만 호출부 사정(스캔 규모)에 따라 다르다. */
export function resolveImapConfig(
  credentials: { user: string; password: string },
  options: { authTimeout?: number } = {},
): ImapConnectionConfig {
  return {
    user: credentials.user,
    password: credentials.password,
    host: process.env.MAIL_IMAP_HOST || DEFAULT_IMAP_HOST,
    port: readPort(process.env.MAIL_IMAP_PORT, DEFAULT_IMAP_PORT),
    tls: true,
    authTimeout: options.authTimeout ?? 10_000,
  };
}

/** SMTP 접속 설정. 465 는 SSL 직결이고 그 외 포트는 STARTTLS 로 본다. */
export function resolveSmtpConfig(credentials: {
  user: string;
  password: string;
}): SmtpConnectionConfig {
  const port = readPort(process.env.MAIL_SMTP_PORT, DEFAULT_SMTP_PORT);
  return {
    host: process.env.MAIL_SMTP_HOST || DEFAULT_SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: credentials.user, pass: credentials.password },
  };
}

/**
 * 발신인. `SMTP_FROM_EMAIL` 이 비면 로그인 계정으로 떨어진다.
 *
 * ⚠️ **구글은 등록·인증된 주소로만 보낸다** — `SMTP_FROM_EMAIL` 에 `ygrd.kr` 주소를 넣으려면
 * 그 계정의 「다른 주소에서 메일 보내기」에 먼저 등록해야 한다. 등록 없이 넣으면 구글이
 * 발신인을 **로그인 계정 주소로 조용히 바꿔** 보낸다(에러가 아니라 치환이라 로그로는
 * 안 보이고, 브랜드사 화면에서만 드러난다).
 */
export function resolveMailFrom(fallbackUser: string): { name: string; email: string } {
  return {
    name: process.env.SMTP_FROM_NAME || "와이그라운드",
    email: process.env.SMTP_FROM_EMAIL || fallbackUser,
  };
}

/**
 * ## 편지함 순회 정책 — 발주 회신(송장) 스캔 전용
 *
 * 회신 스캔은 **어느 폴더에 들어왔는지 모르므로** 폴더를 전수 순회한다. 그런데 무엇을
 * 빼고 어떤 차례로 볼지가 서버마다 다르고, 이름으로만 거르면 **서버를 옮기는 순간 전부
 * 빗나간다.**
 *
 * 🪤 실제로 그 상태였다: 종전 제외 목록은 다음메일의 한국어 폴더명(`지운 편지함` ·
 * `보낸 편지함` · `임시 보관함` — **띄어쓰기 포함**)으로 만들어져 있어, 구글의
 * `휴지통` · `보낸편지함` · `임시보관함` · `전체보관함` 이 **하나도 안 걸린다.**
 * 특히 `전체보관함`은 모든 메일의 사본이라 그대로 두면 메일함 전체를 두 번 훑는다.
 *
 * **판정은 두 겹이다.** ①IMAP 특수용도 속성(`\Trash` 등)이 1차 — 서버 언어와 무관하다.
 * ②이름 매칭이 2차 — 속성을 안 알려 주는 서버(다음메일)를 위한 폴백이며, 비교 전에
 * **공백을 걷어낸다**(위 함정이 정확히 띄어쓰기 차이였다).
 */
const EXCLUDED_SPECIAL_USE = [
  "\\Trash",
  "\\Junk",
  "\\Spam",
  "\\Drafts",
  "\\Sent",
  /** 선택 불가 컨테이너(구글의 `[Gmail]` 자체). 열면 예외가 난다. */
  "\\Noselect",
] as const;

/** 공백을 걷어낸 이름 조각. 소문자 비교라 영문 폴더도 함께 걸린다. */
const EXCLUDED_NAME_HINTS = [
  "trash",
  "spam",
  "junk",
  "drafts",
  "sent",
  "deletedmessages",
  "sentmessages",
  "지운편지함",
  "휴지통",
  "스팸",
  "보낸편지함",
  "임시보관함",
  "예약편지함",
  "내게쓴편지함",
  "카페",
  "cafe",
] as const;

/** 「전체보관함」류 — 제외하지는 않고 **맨 뒤로 미룬다**(아래 `orderMailboxesForScan` 참조). */
const ALL_MAIL_SPECIAL_USE = "\\All";
const ALL_MAIL_NAME_HINTS = ["전체보관함", "allmail"] as const;

export interface MailboxDescriptor {
  name: string;
  /** node-imap 의 `attribs`. 서버가 안 주면 빈 배열. */
  attribs?: readonly string[];
}

function normalizeBoxName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

function hasAttrib(box: MailboxDescriptor, attrib: string): boolean {
  return (box.attribs ?? []).some((a) => a.toLowerCase() === attrib.toLowerCase());
}

/** 「전체보관함」인가 — 모든 메일의 사본이라 순회 차례가 달라진다. */
export function isAllMailbox(box: MailboxDescriptor): boolean {
  if (hasAttrib(box, ALL_MAIL_SPECIAL_USE)) return true;
  const normalized = normalizeBoxName(box.name);
  return ALL_MAIL_NAME_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * 이 편지함을 회신 스캔 대상으로 삼을 것인가.
 *
 * ⛔ **휴지통·스팸을 대상에 넣지 말 것** — 오너가 지운 메일을 근거로 송장을 되살리게 된다.
 * ⛔ **보낸편지함을 넣지 말 것** — 우리가 보낸 발주서 원본이 회신으로 오인된다(호출부에도
 *    `isMyOwnMail` 방어가 있지만, 그건 2차 방어이지 순회 비용까지 없애 주지는 않는다).
 */
export function isScannableMailbox(box: MailboxDescriptor): boolean {
  if (EXCLUDED_SPECIAL_USE.some((attrib) => hasAttrib(box, attrib))) return false;
  const normalized = normalizeBoxName(box.name);
  return !EXCLUDED_NAME_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * 순회 차례: **받은편지함 → 사용자 라벨 → 전체보관함**.
 *
 * 호출부는 첨부를 처음 찾은 편지함에서 **순회를 멈춘다.** 그래서 이 차례가 곧 정책이다.
 *
 * - `INBOX` 가 맨 앞인 것은 회신이 대부분 거기 있기 때문이다(비용 최소).
 * - **`전체보관함`을 빼지 않고 맨 뒤로 미루는 것이 요점이다.** 오너가 회신을 읽고
 *   보관(archive)해 버리면 그 메일은 받은편지함에도 라벨에도 없고 **오직 전체보관함에만**
 *   남는다 — 빼면 그 건은 영원히 "회신 없음"이 된다. 맨 뒤에 두면 앞에서 찾은 경우
 *   비용이 0 이고, 못 찾은 경우에만 열린다. 즉 **비싼 조회는 정확히 필요한 순간에만** 돈다.
 */
export function orderMailboxesForScan(boxes: readonly MailboxDescriptor[]): string[] {
  const scannable = boxes.filter(isScannableMailbox);
  const inbox = scannable.filter((b) => b.name.toUpperCase() === "INBOX");
  const allMail = scannable.filter((b) => b.name.toUpperCase() !== "INBOX" && isAllMailbox(b));
  const rest = scannable.filter((b) => b.name.toUpperCase() !== "INBOX" && !isAllMailbox(b));
  return [...inbox, ...rest, ...allMail].map((b) => b.name);
}
