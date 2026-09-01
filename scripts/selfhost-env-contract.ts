// 셀프호스트 프로덕션 `.env` **처분 선언 표** (T-067, 설계
// `docs/private/specs/2026-08-26-selfhost-env-key-coverage-design.md` §3).
//
// **왜 있나:** 컷오버(2026-08-13) 때 구 플랫폼이 sensitive 값을 빈 문자열로 내려줘
// "이름은 있는데 값이 없는" 줄이 여러 개 남았고, **아무도 그것을 세지 않았다.** 그중
// 하나(`INGEST_TOKEN`)가 카카오 인제스트 분단 사고의 두 번째 원인이었다 — 인제스트는
// fail-closed 라 전량 401 인데, 수집 러너가 레포 밖이라 CRM 쪽에는 **신호가 하나도
// 남지 않았다**(사고 정본 `docs/archive/handoff/kakao-ingest-writes-to-retired-db.md`).
//
// ⛔ **일괄 필수화가 답이 아니다.** 채우면 안 되는 줄(교체 런북이 제거를 지시하는 키),
// 짝 중 하나만 채우는 줄, 채워도 효과가 없는 줄이 섞여 있다. 그래서 키마다 처분을
// **선언**하고, 선언에 없는 키는 미분류로 **경고**한다(재발 구조를 닫는 부분).
//
// ⛔ **값을 다루지 않는다(P0).** 이 파일도 소비자도 「비었는가 아닌가」까지만 본다.
// 값·값의 일부·지문 어느 것도 읽거나 출력하지 않는다.

/** 비었을 때의 처분. 판정 한 줄: 「비어 있는 동안 사람이 알아차릴 계기가 있는가.」 */
export type EnvDisposition =
  /**
   * 오류·배포 중단. 판정은 **둘 중 하나**면 성립한다:
   *   ⓐ 비면 사람이 손대기 전까지 스스로 복구되지 않는 **침묵형 고장**이 난다, 또는
   *   ⓑ 정상 운영에서 **비워질 일이 없는** 값인데 비면 **핵심 기능이 통째로 멈춘다**.
   *
   * ⚠️ **ⓑ 를 빠뜨렸다가 교차 검증에서 잡혔다**(2026-08-26). 초판은 ⓐ 만 규칙으로 적어
   * 놓고 `DATABASE_URL`·`SMTP_*` 처럼 **시끄럽게 실패하는** 항목까지 required 로 뒀다 —
   * 표는 맞았는데 규칙이 그 표를 설명하지 못했고, 실제로 `SMTP_*` 의 사유 문구가 "조용히
   * 0건이 된다"는 **사실이 아닌 서술**로 적혀 있었다(실제로는 502 + 크론 failed 선언).
   * ⛔ ⓑ 를 "중요하니까"로 넓히지 말 것 — **비워질 일이 없다**가 함께 성립해야 한다.
   * 그게 아니면 정상 상태가 배포를 막는다.
   */
  | "required"
  /** 없으면 특정 기능이 꺼진다. 앱은 돈다 → 경고 1줄(무엇이 꺼지는지 함께 적는다). */
  | "degrades"
  /** 없어도 정상 → 조용히 통과. 단 사유 문구가 비면 계약 테스트가 거부한다. */
  | "optional"
  /** 이 파일이 소유하지 않는 키 → **값이 있으면** 경고(오독 유발). */
  | "unused-here";

export type EnvContractEntry = {
  /**
   * env 변수 이름. 🪤 **필드명이 `key` 가 아닌 이유**: `hardcoded-secret-literals.contract.test.ts`
   * 의 「시크릿 이름 상수」 패턴이 `key: "…"` 를 **시크릿 대입**으로 읽어, 값이 env 변수
   * 이름일 뿐인 이 표를 통째로 위반으로 잡는다(실측 — `NAVER_CLIENT_SECRET_BASE64` 가 걸렸다).
   * 검출기를 완화하는 것은 P0 검출면을 건드리는 일이라 별건으로 두고, 여기서는 이름을 피한다.
   */
  envName: string;
  disposition: EnvDisposition;
  /** 왜 이 처분인가 — 소스 근거를 한 줄로. 빈 문자열 금지(계약 테스트가 잡는다). */
  reason: string;
  /**
   * `required` 전용 — **다른 키가 채워져 있으면 비어도 된다**(같은 값의 다른 공급원).
   * 이게 없으면 짝으로 존재하는 키(BASE64 변형·키 풀)가 전부 거짓 오류가 된다.
   */
  satisfiedBy?: readonly string[];
};

/**
 * ⚠️ **새 키를 `infra/selfhost/.env` 에 추가하면 여기에도 행을 추가한다.**
 * 손으로 훑는 스냅샷은 한 번만 맞다(P6 `New Table ⇒ New RLS` 와 같은 규약). 빠뜨리면
 * 점검기가 **미분류 경고**로 표면화한다 — 오류가 아니라 경고인 것은 의도다(도입 시점
 * 백로그로 즉시 실패가 뜨면 점검기가 통째로 무시당한다).
 */
export const SELFHOST_ENV_CONTRACT: readonly EnvContractEntry[] = [
  // ── 레인·DB ────────────────────────────────────────────────────────────────
  {
    envName: "VERCEL_ENV",
    disposition: "required",
    reason:
      "정확히 production 이어야 한다. 아니면 prisma-migrate-on-deploy 가 마이그레이션을 조용히 건너뛰고 성공을 보고하며(다음 스키마 변경 때 P2022 전면 장애), 에이전트 우회 레인의 1차 조건도 함께 풀린다. deploy.sh 가 전용 가드로 먼저 잡는다",
  },
  {
    envName: "DATABASE_URL",
    disposition: "required",
    reason: "Prisma 접속점. deploy.sh 가 host 를 루프백으로 한정하는 전용 가드도 함께 건다",
  },
  {
    envName: "DIRECT_URL",
    disposition: "required",
    reason:
      "migrate deploy 가 세션 락을 쓰려면 트랜잭션 풀러가 아닌 직결이 필요하다. prisma-migrate-on-deploy 가 선제 차단하므로 빌드가 멈춘다",
  },
  {
    envName: "NEXT_PUBLIC_SUPABASE_URL",
    disposition: "required",
    reason: "브라우저 Supabase 클라이언트 — 없으면 로그인 자체가 성립하지 않는다",
  },
  {
    envName: "SUPABASE_URL",
    disposition: "required",
    reason: "서버측 Supabase 접속점. check-env 가 NEXT_PUBLIC_ 쪽과 값이 다른 경우도 따로 잡는다",
  },
  {
    envName: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    disposition: "required",
    reason: "브라우저 Supabase 클라이언트 인증 키",
  },
  {
    envName: "SUPABASE_SERVICE_ROLE_KEY",
    disposition: "required",
    reason:
      "서버 스토리지·계정 관리. 셀러 포털 세션 서명 키도 이 값에서 파생하므로(portal-auth.ts) 비면 포털 로그인까지 던진다",
  },
  {
    envName: "NEXT_PUBLIC_APP_URL",
    disposition: "required",
    reason:
      "OAuth 콜백 리다이렉트 + 인제스트 레인 판정의 **자기 정본 오리진**(ingest-lane.ts). 비면 레인 대조가 성립하지 않는다",
  },

  // ── 시크릿·인증 ─────────────────────────────────────────────────────────────
  {
    envName: "ENCRYPTION_KEY",
    disposition: "required",
    reason:
      "셀러 주민등록번호 암·복호화. 폴백 기본 키를 2026-07-23 에 없앴으므로 비면 런타임이 던진다",
  },
  {
    envName: "ENCRYPTION_KEY_PREVIOUS",
    disposition: "optional",
    reason:
      "키 교체 **전환기에만** 채운다. P6 런북 5단계가 제거를 지시하므로 평시에는 비어 있는 것이 정상이고, check-env 는 반대로 이 값이 **있으면** 경고한다",
  },
  {
    envName: "ASSET_TOKEN_ENCRYPTION_KEY",
    disposition: "required",
    reason:
      "구글 드라이브·캘린더 refresh 토큰 복호화. 폴백을 제거했으므로 비면 그 연동이 던진다",
  },
  {
    envName: "CRON_SECRET",
    disposition: "required",
    reason:
      "크론·웹훅 공유 시크릿. verifyCronAuth 가 fail-closed 라 비면 **모든 예약 작업이 401** 로 멈춘다",
  },
  {
    envName: "INGEST_TOKEN",
    disposition: "required",
    reason:
      "🔴 카카오 인제스트 분단 사고의 두 번째 원인. verifyIngestAuth 가 fail-closed 라 비면 인제스트 계열이 전량 401 인데, **수집 러너가 레포 밖이라 CRM 쪽에는 신호가 하나도 남지 않는다** — required 의 교과서적 정의다",
  },
  {
    envName: "PORTAL_SESSION_SECRET",
    disposition: "optional",
    reason:
      "없으면 SUPABASE_SERVICE_ROLE_KEY 에서 라벨 고정 HMAC 으로 파생한다(portal-auth.ts 의 설계된 폴백). 대가는 service role key 교체 시 포털 세션 일괄 만료이고, 그 트레이드오프는 주석이 명시한다",
  },

  // ── 네이버 커머스(주문·정산) ────────────────────────────────────────────────
  {
    envName: "NAVER_CLIENT_ID",
    disposition: "required",
    reason: "네이버 커머스 API 자격. 비면 주문·정산 동기화가 통째로 던진다",
  },
  {
    envName: "NAVER_CLIENT_SECRET",
    disposition: "required",
    reason:
      "네이버 커머스 시크릿. **BASE64 변형이 있으면 그 값이 덮어쓰므로**(naver-commerce-client.ts) 둘 중 하나만 채워져 있으면 된다 — 둘 다 채우면 출처가 갈린다",
    satisfiedBy: ["NAVER_CLIENT_SECRET_BASE64"],
  },
  {
    envName: "NAVER_CLIENT_SECRET_BASE64",
    disposition: "required",
    reason: "위 키의 base64 변형이자 현재의 실제 공급원. 둘 중 하나면 충족된다",
    satisfiedBy: ["NAVER_CLIENT_SECRET"],
  },
  {
    envName: "NAVER_SEARCH_CLIENT_ID",
    disposition: "degrades",
    reason:
      "네이버 검색 오픈API. 비면 가격 모니터링이 「미설정」 오류를 표면화하고 콘텐츠 가이드 VOC 수집이 빈 배열이 된다",
  },
  {
    envName: "NAVER_SEARCH_CLIENT_SECRET",
    disposition: "degrades",
    reason: "위와 짝. 한쪽만 있어도 두 소비처가 모두 미설정으로 판정한다",
  },

  // ── 사업자 조회 ────────────────────────────────────────────────────────────
  {
    envName: "NTS_SERVICE_KEY",
    disposition: "required",
    reason:
      "🔴 국세청 사업자 조회. 비면 partnerService 가 **가짜 테스트 값을 실제 거래처 행에 써 넣고**(대표자·주소·업태를 테스트 문자열로) bizSyncedAt 까지 찍는다 — 조용한 데이터 오염이라 화면에서는 정상 조회와 구분되지 않는다",
  },

  // ── 메일 ───────────────────────────────────────────────────────────────────
  {
    envName: "SMTP_USER",
    disposition: "required",
    reason:
      "발주 메일 발송 + 수취 계산서 메일 대조 엔진이 같은 계정을 쓴다. 비면 둘 다 통째로 멈추고, 정상 운영에서 비워질 일이 없는 값이라 required(위 ⓑ)다. ⚠️ **침묵형은 아니다** — mail-scan 이 던지고 수취 조회 라우트가 502, 발행 확인 크론이 `failed: true` 로 레이더를 빨갛게 만든다(그 라우트 주석이 「조회 실패를 수취 0건으로 오독하면 오너가 미수취를 못 본다」로 이 실패 모드를 이미 막아 뒀다). 종전 사유 「조용히 0건이 된다」는 **틀린 서술**이었다(교차 검증 2026-08-26)",
  },
  {
    envName: "SMTP_PASS",
    disposition: "required",
    reason: "위와 짝. 같은 침묵형 실패 경로다",
  },
  {
    envName: "SMTP_FROM_EMAIL",
    disposition: "optional",
    reason:
      "비면 SMTP_USER 로 폴백한다(send-email 라우트). ⚠️ 구글은 계정에 **등록·인증된 주소**로만 보낸다 — 등록 없이 ygrd.kr 주소를 넣으면 오류가 아니라 로그인 계정 주소로 **조용히 치환**돼 나가므로, 로그에는 성공으로 남고 브랜드사 화면에서만 드러난다",
  },
  {
    envName: "MAIL_IMAP_HOST",
    disposition: "optional",
    reason:
      "비면 mail-config 의 기본값(구글 수신 서버)을 쓴다. 정상 운영에서 채울 일이 없고, 채우는 경우는 메일 사업자를 다시 옮길 때뿐이다",
  },
  {
    envName: "MAIL_IMAP_PORT",
    disposition: "optional",
    reason: "위와 짝. 비거나 숫자가 아니면 기본값(993)으로 떨어진다",
  },
  {
    envName: "MAIL_SMTP_HOST",
    disposition: "optional",
    reason: "비면 mail-config 의 기본값(구글 발신 서버)을 쓴다. 위 IMAP 항목과 같은 축이다",
  },
  {
    envName: "MAIL_SMTP_PORT",
    disposition: "optional",
    reason: "위와 짝. 465 면 SSL 직결, 그 외 값이면 STARTTLS 로 접속한다",
  },
  {
    envName: "SMTP_FROM_NAME",
    disposition: "optional",
    reason: "비면 코드의 기본 발신자명으로 폴백한다(send-email 라우트)",
  },
  {
    envName: "TAX_INVOICE_MAIL_BOX",
    disposition: "degrades",
    reason:
      "수취 계산서 스캔 대상 메일함 이름. 비면 호출부가 넘긴 값이나 기본 동작으로 떨어져 의도한 메일함을 못 볼 수 있다",
  },

  // ── 수집(인스타·유튜브·유료 폴백) ───────────────────────────────────────────
  {
    envName: "INSTAGRAM_COLLECT_MODE",
    disposition: "required",
    reason:
      "명시 opt-in 이라 미설정은 mock 이 아니라 **거부**다(P9 collect-mode). 비면 인스타 수집 크론이 사유를 남기고 통째로 skip 한다",
  },
  {
    envName: "YOUTUBE_COLLECT_MODE",
    disposition: "required",
    reason: "위와 같은 규약. 비면 유튜브 수집 크론이 skip 한다",
  },
  {
    envName: "INSTAGRAM_ACCESS_TOKEN",
    disposition: "optional",
    reason:
      "장기 토큰의 정본은 **DB(SystemSettings)** 이고 주간 크론이 갱신한다 — 이 파일은 최초 시드일 뿐이라 비어 있는 것이 정상이다(오너 확정 2026-08-26: 60일 만료라 파일에 박으면 두 달 뒤 같은 증상이 돌아온다). ⚠️ 설계서 §4-① 은 이 처분을 degrades 로 적었지만 그건 **코드 수정 전** 기준이다 — 소비처가 게이트 옆에서 DB 토큰을 주입하게 고친 뒤로는 공란이어도 꺼지는 기능이 없어 degrades 문구(「기능 꺼짐」)가 사실과 어긋난다. DB·env 가 **둘 다** 빈 경우는 이 표가 아니라 주간 갱신 크론의 lastError 가 잡고, 주입 누락은 instagram-graph-token-applied.contract.test.ts 가 잡는다",
  },
  {
    envName: "INSTAGRAM_BUSINESS_ACCOUNT_ID",
    disposition: "degrades",
    reason: "비면 무료 Tier0(Graph) 경로가 꺼지고 수집이 공개 스크래퍼로만 돈다",
  },
  {
    envName: "INSTAGRAM_APP_ID",
    disposition: "degrades",
    reason: "비면 주간 장기토큰 갱신 크론이 실패를 기록하고 멈춘다(토큰이 만료되면 Tier0 가 꺼진다)",
  },
  {
    envName: "INSTAGRAM_APP_SECRET",
    disposition: "degrades",
    reason: "위와 짝. 같은 갱신 경로가 멈춘다",
  },
  {
    envName: "YOUTUBE_API_KEY",
    disposition: "degrades",
    reason:
      "감시 유튜브 셀러가 0명이면 대상 0건으로 먼저 return 하므로 지금은 조용하다. 셀러를 한 명이라도 등록하면 수집이 전량 실패하고 채널 정보 조회가 500 이 된다 — 그때 채운다(오너 확정 2026-08-26)",
  },
  {
    envName: "APIFY_API_TOKEN",
    disposition: "degrades",
    reason:
      "유료 폴백(Apify). 비면 그 경로만 꺼진다. 복수형 APIFY_API_TOKENS 와 합쳐 풀을 만든다",
    satisfiedBy: ["APIFY_API_TOKENS"],
  },
  {
    envName: "APIFY_API_TOKENS",
    disposition: "degrades",
    reason: "위 키의 콤마 구분 풀. 둘 중 하나만 있어도 유료 폴백이 돈다",
    satisfiedBy: ["APIFY_API_TOKEN"],
  },
  {
    envName: "RAPIDAPI_KEY",
    disposition: "degrades",
    reason:
      "유료 폴백(RapidAPI). 풀이 비면 호출부가 명시 오류를 던진다 — 조용히 넘어가지 않는다",
    satisfiedBy: ["RAPIDAPI_KEYS"],
  },
  {
    envName: "RAPIDAPI_KEYS",
    disposition: "degrades",
    reason: "위 키의 콤마 구분 풀. 소진 순서가 곧 이 목록의 순서다",
    satisfiedBy: ["RAPIDAPI_KEY"],
  },
  {
    envName: "COUPANG_ACCESS_KEY",
    disposition: "optional",
    reason:
      "2026-07-08 미도입 파킹. 쿠팡은 봇 차단으로 스크래핑이 불가해 공식 API 계약 전에는 채울 값이 없고, 비면 시세 조회를 조용히 건너뛴다(의도된 침묵 — 코드 주석이 선언)",
  },
  {
    envName: "COUPANG_SECRET_KEY",
    disposition: "optional",
    reason: "위와 짝. 같은 파킹 상태다",
  },

  // ── AI ─────────────────────────────────────────────────────────────────────
  {
    envName: "GEMINI_API_KEY",
    disposition: "required",
    reason:
      "AI 표면 전량의 주 키. 풀이 비면 gemini-client 가 NO_KEYS 실패를 계측하지만 그 표면은 눈에 잘 띄지 않는다(2026-08-01 예산 소진 무증상 장애의 계기)",
    satisfiedBy: ["BACKUP_GEMINI_API_KEY"],
  },
  {
    envName: "BACKUP_GEMINI_API_KEY",
    disposition: "optional",
    reason:
      "주 키에 이어 붙는 로테이션 풀. 비면 풀이 1키가 되어 429 때 넘어갈 자리가 없다 — 기능 정지는 아니지만 여유가 없는 정상이다",
  },

  // ── 스토리지 버킷 ──────────────────────────────────────────────────────────
  {
    envName: "SUPABASE_ASSET_BUCKET",
    disposition: "optional",
    reason: "비면 asset-storage 의 기본 버킷 상수로 폴백한다",
  },
  {
    envName: "SELLER_MEDIA_BUCKET",
    disposition: "optional",
    reason: "비면 seller-media-storage 의 기본 버킷 상수로 폴백한다",
  },

  // ── 구글 드라이브 OAuth ────────────────────────────────────────────────────
  {
    envName: "GOOGLE_DRIVE_CLIENT_ID",
    disposition: "degrades",
    reason:
      "비면 드라이브 업로드가 꺼진다. ⚠️ **일부만 비는 것이 더 위험한데** 그 짝 정합은 check-env 의 그룹 검사가 소유한다 — 여기서 재구현하지 말 것",
  },
  {
    envName: "GOOGLE_DRIVE_CLIENT_SECRET",
    disposition: "degrades",
    reason: "위와 같은 그룹. 정합 검사는 check-env 소관",
  },
  {
    envName: "GOOGLE_DRIVE_REDIRECT_URI",
    disposition: "degrades",
    reason: "위와 같은 그룹. 비면 OAuth 콜백이 성립하지 않는다",
  },

  // ── 링크·주소 ──────────────────────────────────────────────────────────────
  {
    envName: "NEXT_PUBLIC_SITE_URL",
    disposition: "degrades",
    reason:
      "로그인 OAuth 리다이렉트와 Apify 웹훅 주소 조립에 쓰인다. 비면 그 경로가 폴백으로 떨어진다(check-env 도 경고한다)",
  },
  {
    envName: "NEXT_PUBLIC_SHORT_LINK_BASE_URL",
    disposition: "optional",
    reason:
      "비면 short-link.ts 의 기본 origin 상수로 폴백한다. 도메인을 바꿀 때만 설정한다(release-config-shared 의 optional 등재와 같은 사유)",
  },
  {
    envName: "WAG_CRM_BASE_URL",
    disposition: "optional",
    reason:
      "앱은 읽지 않는다 — 레포의 카톡 러너 스크립트가 기본 주소로 쓸 뿐이고 비면 로컬 주소로 폴백한다",
  },

  // ── 수집 프록시 ────────────────────────────────────────────────────────────
  {
    envName: "PROXY_URLS",
    disposition: "degrades",
    reason: "리뷰 수집용 프록시 풀. 비면 프록시 없이 직접 호출해 차단 확률이 올라간다",
  },

  // ── 알림·생존신호(셸 스크립트 소관) ────────────────────────────────────────
  {
    envName: "TELEGRAM_BOT_TOKEN",
    disposition: "degrades",
    reason:
      "외부 알림 발송. 비면 notify.sh 가 unconfigured 마커를 남기고 status.sh 가 그것을 표면화하므로 침묵이 아니다",
  },
  {
    envName: "TELEGRAM_CHAT_ID",
    disposition: "degrades",
    reason: "위와 짝. 같은 마커 경로로 표면화된다",
  },
  {
    envName: "HEARTBEAT_URL",
    disposition: "degrades",
    reason:
      "dead-man 생존신호 발신 주소. 비면 heartbeat.sh 가 아무것도 보내지 않고, 신호가 끊기는 것 자체가 dead-man 감시의 알림 조건이라 **시끄러운 쪽으로** 실패한다",
  },
  {
    envName: "HEARTBEAT_TOKEN",
    disposition: "degrades",
    reason:
      "무인증 생존신고를 막는 토큰. 없으면 아예 보내지 않는 것이 설계다(누구나 가짜 신호를 넣어 침묵 판정을 막는 통로가 되기 때문)",
  },
];

export type EnvFinding = { key: string; message: string };
export type EnvEvaluation = {
  ok: boolean;
  errors: EnvFinding[];
  warnings: EnvFinding[];
};

/** 값이 「채워져 있는가」 — 공백만 있는 값은 빈 것으로 본다. ⛔ 값 자체를 반환하지 않는다. */
function filled(entries: Readonly<Record<string, string>>, key: string): boolean {
  const raw = entries[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * 선언 표를 파일 내용에 적용한다(순수 함수 — 파일 IO·`process.env` 접근 없음).
 *
 * ⚠️ **「키가 없음」과 「빈 문자열」을 구분하지 않는다.** check-env 의 `hasValue` 와 같은
 * 판정이고, 컷오버가 남긴 상태가 정확히 "이름은 있는데 값이 없는" 줄이라 둘을 가르면
 * 같은 사고를 절반만 잡는다.
 */
export function evaluateSelfhostEnv(
  entries: Readonly<Record<string, string>>,
  contract: readonly EnvContractEntry[] = SELFHOST_ENV_CONTRACT,
): EnvEvaluation {
  const errors: EnvFinding[] = [];
  const warnings: EnvFinding[] = [];
  const declared = new Set(contract.map((e) => e.envName));

  for (const entry of contract) {
    const isFilled = filled(entries, entry.envName);
    switch (entry.disposition) {
      case "required": {
        if (isFilled) break;
        const alt = entry.satisfiedBy?.find((k) => filled(entries, k));
        if (alt) break;
        const via = entry.satisfiedBy?.length
          ? ` (대체 키 ${entry.satisfiedBy.join(" · ")} 도 비어 있다)`
          : "";
        errors.push({ key: entry.envName, message: `${entry.reason}${via}` });
        break;
      }
      case "degrades":
        if (!isFilled) {
          const alt = entry.satisfiedBy?.find((k) => filled(entries, k));
          if (!alt) warnings.push({ key: entry.envName, message: `기능 꺼짐 — ${entry.reason}` });
        }
        break;
      case "unused-here":
        if (isFilled) {
          warnings.push({
            key: entry.envName,
            message: `이 파일이 소유하지 않는 키인데 값이 들어 있다 — ${entry.reason}`,
          });
        }
        break;
      case "optional":
        break;
    }
  }

  // 미분류 — 선언 표에 없는 키. ⛔ 오류로 올리지 않는다(도입 시점 백로그로 즉시 실패가
  // 뜨면 점검기가 통째로 무시당한다. board:check 가 「좌표 없는 항목」을 경고로만 둔 것과
  // 같은 판단).
  for (const key of Object.keys(entries)) {
    if (!declared.has(key)) {
      warnings.push({
        key,
        message: "미분류 — scripts/selfhost-env-contract.ts 에 처분을 선언할 것",
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
