/**
 * 카카오 인제스트 **레인 정합** SSOT (순수 · 서버/러너 공용).
 *
 * ## 무엇을 막는가 — "성공했는데 엉뚱한 DB 로 갔다" (실사고 2026-08-26)
 *
 * 2026-08-13 셀프호스트 컷오버 이후 **13일간** 카톡 업무기록이 운영 CRM 에 한 건도
 * 들어오지 않았다. 유실이 아니라 **은퇴한 클라우드 배포로 계속 쌓이고 있었다** —
 * launchd 수집 잡(`~/.gemini/antigravity/scripts/kakao-auto-ingest.sh`)이 구 배포 URL 을
 * 하드코딩해 두었고, 그 배포가 살아서 옛 DB 를 물고 **200 을 돌려주고 있었기 때문이다.**
 *
 * 🪤 **이 사고의 본질은 "양쪽 다 정상으로 보인다"는 것이다.** 러너는 `uploaded=N / ingest OK`
 * 를 찍고 종료코드 0 으로 끝났고, 운영 CRM 은 그냥 조용했다. 인증(`verifyIngestAuth`)도
 * 통과한다 — 토큰은 맞았고, **틀린 것은 상대였다.** 그래서 기존 방어선(인증·검증·멱등)
 * 어디에도 걸리지 않았고, 아무 경보도 울리지 않았다.
 *
 * ## 그래서 방어가 두 방향이다 — 한쪽만으로는 이 사고를 못 잡는다
 *
 * 1. **서버가 "네가 부른 레인이 나인가"를 본다** — 러너가 `x-ingest-lane` 으로 *자기가 믿는
 *    상대*를 선언하고, 라우트는 그것을 **자기 자신의 정본 오리진**(`NEXT_PUBLIC_APP_URL`)과
 *    대조해 어긋나면 **아무것도 쓰지 않고 409** 를 준다.
 *    → 잡는 것: 프리뷰 레인(3001, **프로덕션 DB 사본**)으로 잘못 향한 수집 · DNS/프록시
 *      경유로 다른 앱에 닿은 경우 · 앞으로 생길 어떤 배포든 **현행 코드를 돌고 있는 한**.
 *
 * 2. **러너가 "상대가 자기 레인을 밝히는가"를 본다** — 응답의 `lane` 필드가 없으면 러너가
 *    **업로드 전에** 중단한다(`assertServerLane`).
 *    → 잡는 것: **바로 이 사고.** 구 배포는 이 코드가 없어 `lane` 을 못 실으므로, 같은 일이
 *      또 벌어지면 첫 실행에서 러너가 죽고 launchd 로그에 `ERROR: ingest FAILED` 가 남는다.
 *
 * ⛔ **1번만 넣고 끝내지 말 것.** 서버 쪽 검사는 **그 코드가 배포된 곳에서만** 돈다 —
 * 이 사고의 상대는 정의상 **낡은 코드를 돌고 있는 배포**라, 서버 검사는 원리적으로 도달하지
 * 못한다. 실효 방어는 2번(클라이언트 단언)이고, 1번은 미래의 오배송을 덮는다.
 *
 * ## 판정 불능일 때 어느 쪽으로 넘어지는가 (의도된 비대칭)
 *
 * - **서버는 자기 레인을 모르면 거부하지 않는다**(`laneUnknown` 고지 후 통과).
 *   서버가 fail-closed 면 `NEXT_PUBLIC_APP_URL` 하나가 비는 순간 **프로덕션 수집이 통째로
 *   막힌다** — 이 트랙은 이미 `INGEST_TOKEN` 공란으로 그 사고를 겪었다.
 * - **러너는 모르면 쓰지 않는다**(fail-closed). 틀렸을 때의 대가가 비대칭이기 때문이다:
 *   러너가 멈추면 아카이브에 원본이 남아 **고친 뒤 그대로 따라잡히지만**(커서가 안 전진),
 *   모르는 채로 쓰면 **어디에 썼는지 모르는 데이터**가 생긴다.
 *
 * ⚠️ **로컬 루프백은 이 체계 밖이다.** dev 서버의 `NEXT_PUBLIC_APP_URL` 은 프로덕션 오리진을
 * 가리키는 것이 정상이라, 루프백 대상에 레인 단언을 걸면 **로컬 예행이 전부 409** 가 된다.
 * 그래서 러너는 루프백 대상에는 선언 자체를 보내지 않는다(`resolveDeclaredLane`). 이 사고의
 * 부류(원격 배포 오배송)는 루프백에 존재하지 않으므로 방어 공백이 아니다.
 */

/** 러너가 "내가 부르고 있다고 믿는 레인"을 선언하는 헤더. */
export const INGEST_LANE_HEADER = "x-ingest-lane";

/**
 * 오리진 정규화 — **서버와 러너가 같은 함수를 쓴다.**
 * 각자 손으로 자르면 후행 슬래시·대소문자·기본 포트에서 갈려 정상 레인이 mismatch 가 된다
 * (이 레포의 반복 결함: 같은 계약을 다시 구현하는 호출부는 반드시 갈라진다).
 *
 * 판정 불가(빈값·비 URL)는 `null` 이다 — 빈 문자열로 접으면 "모름"과 "빈 레인"이 같아진다.
 */
export function normalizeLaneOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    // URL.origin 이 프로토콜·호스트·비기본 포트만 남기고 경로·쿼리·후행 슬래시를 떨군다.
    const origin = new URL(trimmed).origin;
    return origin === "null" ? null : origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 이 배포가 스스로 밝히는 정본 오리진. 판정 불가면 `null`.
 *
 * ⛔ 요청의 `Host` 헤더로 대체하지 말 것 — 그러면 "네가 부른 주소"와 "내가 받은 주소"를
 * 비교하게 되어 **항상 일치**한다(구 배포도 통과한다). 판정이 성립하려면 서버가 **요청과
 * 무관한 자기 신원**을 말해야 한다.
 */
export function resolveIngestLane(): string | null {
  return normalizeLaneOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

export type LaneVerdict =
  /** 선언과 서버 신원이 일치 — 정상. */
  | "match"
  /** 선언과 서버 신원이 다름 — 오배송. 쓰기 금지. */
  | "mismatch"
  /** 서버가 자기 레인을 모름 — 서버는 통과시키고 러너가 판단한다. */
  | "unknown-server"
  /** 클라이언트가 선언하지 않음 — 레거시·수동 호출자. 통과. */
  | "undeclared";

export function classifyIngestLane(
  declared: string | null | undefined,
  actual: string | null | undefined,
): LaneVerdict {
  const declaredOrigin = normalizeLaneOrigin(declared);
  if (!declaredOrigin) return "undeclared";
  const actualOrigin = normalizeLaneOrigin(actual);
  if (!actualOrigin) return "unknown-server";
  return declaredOrigin === actualOrigin ? "match" : "mismatch";
}

/** 인제스트 계열 응답에 항상 실리는 레인 신원 봉투. */
export type IngestLaneEnvelope = { lane: string | null; laneUnknown?: true };

export function ingestLaneEnvelope(lane: string | null): IngestLaneEnvelope {
  // ⚠️ `lane` 키는 서버가 **모를 때도** 실린다(값 null + `laneUnknown`). 키 자체를 빼면
  // 러너가 "구 배포(필드 없음)"와 "설정 누락"을 구분할 수 없어, 이 사고의 판정이 무너진다.
  return lane === null ? { lane: null, laneUnknown: true } : { lane };
}

/**
 * 라우트 진입부의 레인 게이트. **인제스트 계열 라우트 전부가 이것을 부른다**
 * (누락은 `ingest-lane.contract.test.ts` 의 소스 스캔이 막는다).
 *
 * 반환값의 `rejection` 이 있으면 그대로 돌려주고 **어떤 쓰기도 하지 않는다.**
 * 없으면 성공 응답 본문에 `envelope` 를 펼쳐 넣는다.
 */
export function ingestLaneGuard(request: Request): {
  rejection: Response | null;
  envelope: IngestLaneEnvelope;
} {
  const lane = resolveIngestLane();
  const declared = request.headers.get(INGEST_LANE_HEADER);
  const verdict = classifyIngestLane(declared, lane);
  const envelope = ingestLaneEnvelope(lane);

  if (verdict === "mismatch") {
    return {
      rejection: Response.json(
        {
          error: "ingest lane mismatch",
          // 진단에 필요한 두 값을 함께 싣는다 — 한쪽만 있으면 러너 로그에서
          // "무엇을 무엇으로 착각했는가"를 재구성할 수 없다. 둘 다 오리진이라 비밀이 아니다.
          declaredLane: normalizeLaneOrigin(declared),
          ...envelope,
        },
        { status: 409 },
      ),
      envelope,
    };
  }

  return { rejection: null, envelope };
}

/**
 * 루프백(로컬 dev)인가 — 참이면 러너는 레인 선언·단언을 건너뛴다.
 *
 * ⚠️ 호스트 이름만 본다. `.localhost` 하위도 루프백으로 해석되는 것이 브라우저·Node 관례라
 * 함께 포함한다.
 */
export function isLoopbackTarget(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // IPv6 루프백은 URL 파서가 대괄호를 벗겨 "::1" 로 준다.
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host === "::1"
  );
}

// ---------------------------------------------------------------------------
// 러너(클라이언트) 측 — 이 트랙의 **실효 방어선**이다. 위 서버 게이트와 같은 파일에 두는 것은
// 의도다: 두 쪽이 오리진을 각자 정규화하면 정상 레인이 mismatch 로 뜬다.
// ---------------------------------------------------------------------------

/**
 * 이 실행이 상대에게 선언하는 레인. 루프백(로컬 dev)이면 `null` — 선언도 단언도 하지 않는다
 * (사유는 `src/lib/kakao/ingest-lane.ts` 헤더의 「로컬 루프백은 이 체계 밖이다」).
 */
export function resolveDeclaredLane(baseUrl: string): string | null {
  if (isLoopbackTarget(baseUrl)) return null;
  return normalizeLaneOrigin(baseUrl);
}

export function laneHeaders(declaredLane: string | null): Record<string, string> {
  return declaredLane ? { [INGEST_LANE_HEADER]: declaredLane } : {};
}

/**
 * 상대가 밝힌 레인 신원을 검증한다 — **업로드가 시작되기 전에** 부른다.
 *
 * 이 단언이 이 트랙의 실효 방어선이다: 2026-08-26 실사고의 상대(은퇴한 구 배포)는 서버 쪽
 * 레인 게이트 코드가 아예 없어 `lane` 필드를 싣지 못한다. 즉 **필드의 부재가 곧 오배송의
 * 지문**이고, 서버 쪽 검사로는 원리적으로 잡을 수 없다.
 *
 * 던지면 러너가 종료코드 1 로 죽고, launchd 래퍼가 `ERROR: ingest FAILED` 를 남긴다.
 * 아카이브에 원본이 남아 있고 서버 커서도 전진하지 않으므로 **고친 뒤 그대로 따라잡힌다.**
 */
export function assertServerLane(declaredLane: string | null, body: { lane?: unknown; laneUnknown?: unknown }): void {
  if (!declaredLane) return; // 루프백 — 체계 밖

  const hasLaneKey = Object.prototype.hasOwnProperty.call(body, "lane");
  if (!hasLaneKey) {
    throw new Error(
      `[lane] 상대가 자기 레인을 밝히지 않았다. 레인 게이트가 없는 낡은 배포일 수 있다. ` +
        `대상=${declaredLane}. 업로드를 중단한다(2026-08-26 실사고: 은퇴 배포가 13일간 200 을 돌려줬다). ` +
        `대상 URL(WAGCRM_INGEST_URL)이 현행 운영 배포를 가리키는지 확인할 것.`,
    );
  }

  const reportedLane = normalizeLaneOrigin(typeof body.lane === "string" ? body.lane : null);

  if (reportedLane === null) {
    // 상대는 현행 코드를 돌고 있는데(=`lane` 키가 있다) 자기 오리진을 모른다
    // (`NEXT_PUBLIC_APP_URL` 미설정). 위 경우와 신호의 성격이 다르다 — 처분은 아래 정책.
    // (`never` 를 반환하므로 여기서 실행이 끝난다.)
    handleUnknownServerLane(declaredLane);
  }

  if (reportedLane !== declaredLane) {
    throw new Error(
      `[lane] 레인 불일치. 부른 곳=${declaredLane}, 상대가 밝힌 신원=${reportedLane}. ` +
        `업로드를 중단한다(다른 배포·다른 DB 로 쓸 위험).`,
    );
  }
}

/**
 * 상대가 **현행 코드를 돌고 있지만** 자기 오리진을 모를 때(`{ lane: null, laneUnknown: true }`
 * — 서버에 `NEXT_PUBLIC_APP_URL` 미설정)의 처분: **보내지 않는다**(오너 확정 2026-08-26).
 *
 * 위 `lane` 키 부재(=낡은 배포)와 신호의 성격이 다르다 — 이쪽 상대는 우리 토큰을 통과했고
 * 현행 코드를 돌고 있으니 "우리 앱"인 것은 맞다. 그런데도 막는 근거는 **비대칭**이다:
 * - 막았을 때 잃는 것 = 수집이 며칠 밀리는 것뿐이다. 카톡 원본은 로컬 아카이브에 남아 있고
 *   서버 커서도 전진하지 않으므로, 설정을 고치면 밀린 구간이 **한 번에 따라잡힌다**
 *   (2026-08-26 백필이 정확히 그 경로였다 — 새 스크립트 없이 러너 재실행으로 복구됐다).
 * - 보냈을 때 잃는 것 = **어디에 썼는지 모르는 데이터**다. 이 트랙은 그 상태를 13일간 겪었고,
 *   되돌리는 데 든 것은 두 DB 대조와 오너 승인이었다.
 *
 * ⚠️ 이것은 가정적 방어가 아니다 — 같은 날 `INGEST_TOKEN` 이 프로덕션 env 에서 **빈 값**이었고
 * (컷오버 때 Vercel sensitive env 가 빈값으로 내려온 여파) 아무도 몰랐다. 설정 한 줄이 비는
 * 일은 이 레인에서 실제로 일어난다.
 *
 * ⛔ 경고 후 진행으로 완화하지 말 것 — 완화하면 이 함수가 존재할 이유가 없어진다.
 */
export function handleUnknownServerLane(declaredLane: string): never {
  throw new Error(
    `[lane] 상대(${declaredLane})가 자기 오리진을 밝히지 못했다. 그 배포에 ` +
      `NEXT_PUBLIC_APP_URL 이 설정돼 있지 않다. 어디에 쓰는지 확인할 수 없으므로 업로드를 ` +
      `중단한다. 설정을 채운 뒤 다시 실행하면 밀린 구간까지 한 번에 따라잡는다(커서 미전진).`,
  );
}
