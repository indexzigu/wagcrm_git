// 크론 잡 명세 SSOT — 레이더 카드(system-radar-card.tsx)의 표시 목록과 수동 실행 API
// (/api/system/cron-run)의 허용 목록이 이 한 파일에서 나온다. 예전에는 두 파일이 각자
// 목록을 들고 "함께 갱신할 것" 주석으로만 동기화했는데, collect-qnas·analyze-voc 추가 때
// 레이더만 갱신돼 수동 실행 버튼이 400으로 죽는 드리프트가 실제로 났다. 서버 라우트가
// import해야 하므로 "use client" 파일이 아닌 여기(중립 모듈)에 둔다.
//
// 예정 시각(timeKst)은 **스케줄 정본인 `infra/selfhost/crontab`**(오너 맥, KST로 돈다)의
// 분·시를 그대로 옮긴 값이다. 스케줄이나 잡 목록을 바꾸면 그 파일과 이 목록을 함께 갱신한다
// — 라우트 존재·스케줄 등록·표기 정합은 cron-jobs.contract.test.ts가 검증한다.
// scheduled-crons.yml은 수동 재실행(workflow_dispatch) 폴백 전용이다.
//
// ⛔ 종전 서술 "스케줄 정본은 vercel.json crons"는 **SUPERSEDED**(2026-08-15) — 2026-08-13
// 컷오버 이후 실제 발화 주체는 자체호스팅 crontab 인데 vercel.json 에 crons 가 남아 있어,
// 구 Vercel 배포가 **같은 잡을 1분 뒤에 또 발화**하고 있었다(07:00 자체호스팅 / 07:01 구
// 배포, 실측). vercel.json 은 배포마다 크론을 재등록하므로 파일에 남겨 두는 것 자체가
// 부활 장치였다 — crons 키를 제거했고, 그 부재를 계약 C2 가 고정한다.
// desc: 행 클릭 시 여는 인박스 팝오버의 설명 문구(무엇을 하는 크론인지, 오너 참조용).
//
// lane: 이 잡을 **누가 발화하는가**. "vercel" = 공용 스케줄러(`infra/selfhost/crontab`, 기본.
// 값 이름은 안정 식별자라 컷오버 후에도 그대로 둔다) · "local" = 오너 맥의 launchd 러너.
// 레인을 필드로 둔 이유는 계약이 양방향이기 때문이다 — 공용 레인은 crontab 에 **있어야**
// 하고(C6), local 레인은 거기 **없어야** 한다(C2)(둘 다 있으면 이중
// 발화이고, 둘 다 없으면 레이더가 안 도는 크론을 예정 시각과 함께 보여 주는 거짓말이 된다).
//
// ✅ **2026-08-19 현재 local 레인은 비어 있다** — 마지막 거주자 capture-stories 가 공용
// 레인으로 돌아왔다(오너 결정). 로컬 레인이 존재한 이유는 "뷰어가 **Vercel** 클라이언트에
// 캡차를 요구한다"(2026-08-04)였는데, 2026-08-13 셀프호스팅 컷오버로 **앱 자체가 오너 맥에서
// 돌게 되어** 공용 레인의 발화도 주거용 IP 를 탄다 — 전제가 소멸했다.
//   🪤 **레인을 하나 더 두는 것 자체가 비용이었다.** 로컬 레인의 launchd 러너는 공용 레인과
//   **다른 env 파일**(개발 체크아웃의 `.env`)을 읽었는데, 그 파일이 프리뷰 DB 를 가리키게
//   바뀌자 러너가 매일 밤 DB 접속 실패로 즉사했다. 상태 기록조차 DB 쓰기라 `SystemTaskStatus`
//   는 마지막 성공에 얼어붙었고 — 즉 **관측 상실이 실패의 결과가 아니라 실패와 함께** 왔다 —
//   6일 뒤 오너가 화면에서 알아채기 전까지 아무 신호가 없었다(스토리는 24h 뒤 소멸이라
//   그 6일치는 소급 불가). 새 잡을 로컬 레인에 놓고 싶어지면 이 대가를 먼저 계산할 것.
// 레인 필드와 아래 계약(C2·C5 의 local 분기)은 **의도적으로 남겨 둔다** — 판정 장치를 지우면
// 다음 로컬 잡이 무방비로 태어난다. 지금은 대상이 0건이라 공회전(vacuous)한다.
//
// ⛔ collect-reviews(상품 리뷰 수집, 구 08:15)는 이 목록에 없다 — 안 도는 크론을 "매일 08:15"로
// 계속 보여 주면 레이더가 거짓말을 한다(마지막 실행만 낡아 갈 뿐 상태는 정상으로 남는다).
// 2026-07-19 스케줄 일시중단 → **2026-07-31 오너 결정으로 중단 확정**: 네이버 안티봇 강화로
// 서버·로컬 7경로 전부 차단됐고(주거용 IP에서도 CAPTCHA — 원인이 IP가 아니라 자동화 탐지),
// 실행 위치·언어를 바꿔도 동일하다. **재시도·우회 금지**(상세·금지 목록:
// REVIEW_QNA_COLLECTION_PLAN.md §2-B-종결). 재개는 **네이버 공식 리뷰 API 제공 시**에만 하고,
// 그때 vercel.json crons 추가와 **같은 PR에서** 이 행을 되돌린다. 리뷰 공백은 문의(QnA) 기반
// VOC(collect-qnas + analyze-voc)가 메우고 있다.
/** 이 잡을 누가 발화하는가 — 위 lane 주석이 정본. */
export type CronLane = "vercel" | "local";

export type KnownJob = {
  readonly key: string;
  readonly name: string;
  readonly cycle: string;
  readonly timeKst: string;
  readonly lane: CronLane;
  readonly desc: string;
};

// ⚠️ `as const` 가 아니라 명시 타입인 것은 **의도다.** 리터럴 추론을 쓰면 lane 의 타입이 현재
// 값들의 합집합(= 지금은 "vercel" 하나)으로 좁아져, 계약 테스트의 `lane === "local"` 비교가
// **TS2367 로 컴파일 자체를 거부한다** — 즉 로컬 레인이 비는 순간 그 가드를 지우도록 타입이
// 등을 떠민다. 넓힌 것은 lane 뿐 아니라 key 도지만 소비처는 전부 string 으로 쓴다(전수 확인).
export const KNOWN_JOBS: readonly KnownJob[] = [
  { key: "enrich-inbox", name: "인박스 썸네일 수집", cycle: "매일", timeKst: "03:00", lane: "vercel", desc: "발굴 인박스에 등록된 셀러 후보의 프로필 썸네일을 수집·보강합니다." },
  { key: "rehost-seller-media", name: "미디어 재호스팅", cycle: "매일", timeKst: "05:00", lane: "vercel", desc: "셀러 프로필·미디어 이미지를 외부 URL에서 내부 저장소로 재호스팅해 만료를 방지합니다." },
  { key: "naver-settlement-sync", name: "네이버 정산 동기화", cycle: "매일", timeKst: "06:30", lane: "vercel", desc: "네이버페이 정산 내역을 조회해 캠페인 정산 케이스에 반영합니다." },
  { key: "naver-order-sync", name: "네이버 발주 동기화", cycle: "매일", timeKst: "07:00", lane: "vercel", desc: "네이버 스토어 주문 스냅샷을 수집해 발주·배송 상태를 갱신합니다." },
  { key: "enrich-references", name: "레퍼런스 심층 수집", cycle: "매일", timeKst: "07:30", lane: "vercel", desc: "발굴 레퍼런스의 인스타·유튜브 상세 지표를 심층 수집합니다." },
  { key: "collect-qnas", name: "상품 문의 수집", cycle: "매일", timeKst: "08:00", lane: "vercel", desc: "네이버 상품문의·고객문의(VOC)를 수집해 상품·캠페인에 귀속합니다." },
  { key: "analyze-voc", name: "VOC AI 인사이트", cycle: "매일", timeKst: "08:30", lane: "vercel", desc: "신규 문의·리뷰가 임계 이상 쌓인 딜만 골라 AI 요약(소구점·불만·FAQ)을 생성합니다." },
  { key: "price-monitoring", name: "최저가 모니터링", cycle: "매일", timeKst: "13:00", lane: "vercel", desc: "캠페인 상품의 최저가를 판매기간 ±7일 창에서 수집하고 가격 위반을 감지합니다." },
  { key: "capture-stories", name: "스토리 스냅샷 수집", cycle: "매일", timeKst: "00:00", lane: "vercel", desc: "행사 수집창(시작 7일 전~마감 1일 후) 캠페인의 인스타 셀러 스토리를 익명 뷰어로 전량 스냅샷 수집합니다. 태그·멘션과 무관하게 다 담고, 우리 캠페인 홍보인지는 나중에 썸네일로 분류합니다. ⚠️ 스토리는 24시간 뒤 사라지므로 거른 회차는 소급이 불가능합니다. 이 줄이 지연으로 뜨면 그날 밤 수집이 통째로 빠졌다는 뜻이니 맥이 꺼져 있었는지부터 확인하세요. 아직 같은 날 안이라면 지금 실행 버튼으로 만회할 수 있습니다." },
  { key: "collect-campaign-posts", name: "캠페인 게시물 수집", cycle: "매일", timeKst: "00:00", lane: "vercel", desc: "캠페인 관련 셀러 게시물 후보를 수집합니다." },
  { key: "refresh-instagram-token", name: "Instagram 토큰 갱신", cycle: "매주 월", timeKst: "11:00", lane: "vercel", desc: "인스타그램 장기 액세스 토큰을 만료 전에 갱신합니다." },
  { key: "collect-instagram", name: "Instagram 셀러 분석", cycle: "매일", timeKst: "12:00", lane: "vercel", desc: "감시 셀러의 인스타그램 프로필·성과 지표를 수집합니다. 매일 돌면서 마지막 갱신에서 7일이 지난 셀러만 골라 수집합니다." },
  { key: "collect-youtube", name: "YouTube 셀러 분석", cycle: "매일", timeKst: "12:00", lane: "vercel", desc: "감시 셀러의 유튜브 채널 지표를 수집합니다. 매일 돌면서 마지막 갱신에서 7일이 지난 셀러만 골라 수집합니다." },
  { key: "recampaign-auto-propose", name: "재진행 적기 자동 기안", cycle: "매일", timeKst: "09:00", lane: "vercel", desc: "재진행 시점이 온 (셀러×딜) 조합을 승인 대기 기안으로 올립니다. 매출 D3 문턱을 넘는 조합만 자동 발화하고(화면에는 문턱 미만도 전부 보입니다), 같은 조합은 쿨다운 3개월 안에 다시 올리지 않습니다. 승인하면 셀러에 재접촉 결정이 메모로 남습니다. 셀러에게 나가는 것은 없습니다." },
  { key: "tax-invoice-issue-confirm", name: "발행 계산서 자동 확정", cycle: "매일", timeKst: "10:00", lane: "vercel", desc: "세금계산서 전용 메일함을 읽어, 우리가 발행한 계산서를 정산 건과 대조해 발행일을 자동으로 찍습니다. 첨부(국세청 표준 XML)를 연 건만 대상이고 금액이 완전히 맞을 때만 확정합니다. 어긋나면 찍지 않고 「확인 필요」로 남기므로 그때는 정산 화면에서 직접 완료를 누르면 됩니다. 이미 찍힌 날짜는 덮지 않고, 메일이 없다고 해서 이미 찍힌 것을 지우지도 않습니다." },
  { key: "db-exposure-audit", name: "DB 노출 방어 감사", cycle: "매일", timeKst: "02:00", lane: "vercel", desc: "Supabase Data API 노출 방어 두 겹(anon GRANT 회수 · public 테이블 RLS)이 그대로인지 점검합니다. 방어가 벗겨져도 앱은 멀쩡히 돌아 사람이 알아챌 계기가 없으므로 기계가 매일 확인합니다. 빨강이면 유출이 났다는 뜻이 아니라 방어가 한 겹으로 줄었다는 뜻입니다." },
  { key: "encryption-key-audit", name: "암호화 키 정합 감사", cycle: "매일", timeKst: "02:30", lane: "vercel", desc: "저장된 셀러 주민등록번호가 현재 암호화 키로 열리는지 점검합니다. 키가 데이터와 어긋나면 화면에는 그냥 빈칸으로 보여서(미입력과 구분되지 않습니다) 사람이 알아챌 계기가 없으므로 기계가 매일 셉니다. 개수만 세고 값은 어디에도 남기지 않으며, 읽기만 합니다. 빨강이면 그 셀러의 정산·원천징수 화면에서 주민등록번호가 비어 보이는 상태라는 뜻입니다." },
];

// 수동 실행 허용 목록 — 레이더의 모든 행에 실행 버튼이 붙으므로, 표시 목록에서 파생시켜
// "버튼은 있는데 API가 거부"하는 상태를 구조적으로 없앤다. 스케줄이 일시중단된 잡
// (collect-reviews)은 KNOWN_JOBS에 없어 여기서도 자동으로 빠진다 — 그런 잡의 수동 발화는
// 워크플로 dispatch(endpoints 명시)로만 한다.
export const KNOWN_JOB_KEYS: ReadonlySet<string> = new Set(KNOWN_JOBS.map((job) => job.key));
