/**
 * 촬영 컷 시안(스케치) — 순수 로직.
 *
 * 콘텐츠 가이드의 `## 포맷 추천` 이 내보내는 컷(`C1 · 자리 | 피사체 | 하는 일`)마다
 * **구도 스케치 1장**을 그려 프레임 안에 채운다. 가이드 생성과 **함께** 진행한다 —
 * 버튼으로 빼면 "시안 없는 가이드"가 기본값이 되어 기능이 사실상 안 쓰인다(오너 판단).
 *
 * ⚠️ **제품 사진이 아니다.** 실물과 다른 제품 이미지는 셀러에게 잘못된 기준을 주고
 * 표시광고 측면에서도 근거 없는 시각 주장이 된다. 그래서 프롬프트가 **흑백 선화·구도
 * 전용**으로 못박고(`SKETCH_STYLE_LOCK`), 로고·글자·식별 가능한 얼굴을 금지한다.
 * 이 문구는 계약 테스트가 고정한다 — 완화는 오너 승인 사안이다.
 *
 * 비용 설계: 시안은 **컷 텍스트의 함수**다. 같은 컷이면 같은 그림이므로 컷 키로
 * 캐시해 재생성 시 재사용한다 — 초안을 다시 돌려도 컷이 그대로면 이미지 비용이 0이다.
 * 폭주 차단은 `MAX_SKETCHES_PER_GUIDE` 한 곳에서 한다.
 */
/**
 * ⚠️ 이 모듈은 **서버·브라우저 양쪽에서 실행된다.** 검수/가이드 화면의 클라이언트
 * 컴포넌트(`content-guide-view.tsx`)가 `cutSketchKey`로 컷↔시안을 대응시키기 때문이다.
 * 그래서 여기에는 **Node 전용 API를 import하지 않는다** — 종전 `node:crypto` import가
 * `deals-panel → content-guide-view → guide-sketch` 경로로 클라이언트 번들에 끌려
 * 들어가 로컬 dev(webpack)에서 `UnhandledSchemeError: node:crypto` 로 컴파일을
 * 통째로 세웠다(딜 화면 진입 시 그 dev 세션 전체가 막혔다).
 */
import type { GuideCut, GuideKind } from "@/lib/content-guide";
import { DEFAULT_GUIDE_KIND } from "@/lib/content-guide";

/**
 * 한 번 생성에 그릴 시안 상한.
 *
 * 왜 필요한가: 이미지는 텍스트보다 단위 비용이 100배대라, 모델이 컷을 10개 뱉는
 * 이상 응답 하나가 곧 비용 사고가 된다. 프롬프트는 3~5컷을 요구하지만 **모델 출력은
 * 보장이 아니다** — 상한은 코드에 둔다. 초과분은 조용히 버리지 않고 호출부가
 * `skipped` 로 보고한다.
 *
 * 값이 5 → 8 인 이유(오너 결정 2026-08-02): 프롬프트가 **채널당** 3~5컷을 요구하는데
 * 한 딜에 릴스와 피드가 함께 붙으면 컷이 8개가 된다. 5 로 두면 뒤 채널(피드)의
 * 프레임이 통째로 "상한 초과"로 남아, 정작 형식을 지킨 컷이 화면에서 비어 보인다.
 * 상한은 **새로 그리는 것**에만 걸리므로 재생성 비용은 여전히 캐시로 0이다.
 */
export const MAX_SKETCHES_PER_GUIDE = 8;

/**
 * 스타일 락 — "촬영 지시서 스케치"와 "제품 사진"을 가르는 장치.
 *
 * ⚠️ **전량 긍정 서술이다. 부정문(`Do NOT …`)으로 되돌리지 말 것.**
 * 종전 락은 6줄 중 4줄이 금지문이었고 실측 결과 **그 금지가 샜다** — 프로덕션 시안에
 * 숫자·필기체가 그려졌고(2026-08-02 실측), 비교 생성에서는 프롬프트에 쓴 단어가
 * 그대로 그림 속 영문 주석이 됐다("SOFT SPARKLE" · "SCENE 2" 등). 이미지 모델에서
 * 부정 대상 어휘는 **그려질 후보로 먼저 읽힌다**(Pink Elephant). 금지 대신 원하는
 * **상태를 형상으로** 서술하면 같은 회차에서 글자가 0 건이 됐다.
 *
 * 락은 프롬프트 **끝**에 온다 — 서두 가중치가 가장 크므로 그 자리는 피사체가 갖고,
 * 스타일·조명은 후반에 두는 것이 이 모델의 문법이다.
 */
export const SKETCH_STYLE_LOCK = [
  "Style: loose gestural pencil strokes with visible construction lines, open unfinished edges and sketchy overshooting lines, lightly softened with grayscale washes for mood and lighting — quick and unpolished, the way a shot is blocked out before filming, rather than a finished illustration or a product photo.",
  "Every surface and every icon stays plain and unmarked, left as empty outlines.",
  "Keep people cropped below the chin so only the neckline, shoulders and hands are in frame.",
  "Draw the product only as far as the scene describes it, keeping its shape simple and generic.",
].join(" ");

/**
 * 프롬프트 세대. **캐시 키의 일부다** — 이 값을 올리면 기존 시안이 전부 무효가 되고
 * 다음 생성에서 새 화풍으로 다시 그려진다.
 *
 * 왜 필요한가: 키가 컷 텍스트만 덮으면 **프롬프트를 바꿔도 옛 화풍 그림이 영원히
 * 재사용된다.** #232 사고(해시 교체로 멀쩡한 그림이 고아가 됨)의 정반대 실패다 —
 * 이쪽은 낡은 그림이 조용히 살아남는다. 화풍·스타일 락을 손대면 이 값을 함께 올린다.
 */
export const SKETCH_PROMPT_VERSION = "v2";

/** 이미지 규격 — 릴스 세로 비율, 최소 해상도(스케치라 512로 충분하고 저장·비용에 유리). */
export const SKETCH_ASPECT_RATIO = "9:16";
export const SKETCH_IMAGE_SIZE = "512";
export const SKETCH_MIME_TYPE = "image/jpeg";

/**
 * 컷 캐시 키 — **시안이 컷 텍스트의 함수**라는 설계를 그대로 옮긴 것.
 *
 * 자리(`slot`)와 피사체(`subject`)만 넣는다. `why`(이 컷이 하는 일)는 **그림에
 * 영향을 주지 않으므로** 키에서 뺀다 — 넣으면 카피만 다듬어도 캐시가 깨져 돈이 나간다.
 * 번호(`no`)도 뺀다: 컷 순서만 바뀐 경우 같은 그림을 다시 그릴 이유가 없다.
 */
// FNV-1a 32비트 2회 — 순수 TS라 서버·브라우저가 **같은 값**을 낸다(위 모듈 주석 참조).
//
// 이 키의 용도는 콘텐츠 주소지정(캐시 조회)이지 보안이 아니므로 암호학적 해시가 필요
// 없다. 종전 sha256 은 이 일에 과한 도구였고, 그 대가로 Node 전용 API 의존이 붙어
// 있었다. 충돌 시 실패 모드는 "다른 두 컷이 같은 시안을 공유한다"로 눈에 보이며,
// 가이드 한 건의 컷 수(MAX_SKETCHES_PER_GUIDE)를 감안하면 64비트로 충분하다.
//
// ⚠️ BigInt 로 64비트를 한 번에 돌리지 않는다 — tsconfig target 이 ES2017 이라
// BigInt 리터럴이 TS2737 로 막힌다(실측). 전역 target 을 올리는 것은 이 수정의
// 범위를 한참 넘으므로, 서로 다른 오프셋으로 32비트를 두 번 돌려 64비트를 만든다.
// TextEncoder 는 Node 18+·브라우저 공통 전역이라 import 가 필요 없다.
const FNV_PRIME_32 = 0x01000193;
const FNV_OFFSET_32 = 0x811c9dc5;
// 두 번째 패스의 오프셋 — 황금비 상수를 섞어 첫 패스와 다른 수열을 타게 한다.
const FNV_OFFSET_32_ALT = (FNV_OFFSET_32 ^ 0x9e3779b9) >>> 0;

function fnv1a32(bytes: Uint8Array, offsetBasis: number): number {
  let hash = offsetBasis;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME_32);
  }
  return hash >>> 0;
}

function cacheKeyHex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const lo = fnv1a32(bytes, FNV_OFFSET_32);
  const hi = fnv1a32(bytes, FNV_OFFSET_32_ALT);
  // 16자리 hex 고정 — 종전 sha256 절단본과 같은 모양이라 저장 경로 형태가 바뀌지 않는다.
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * ⚠️ **가이드 유형이 키에 들어간다 — 넣지 않으면 두 유형이 서로의 시안을 재사용한다.**
 *
 * 같은 딜에서 셀러형과 브랜드형이 같은 자리·같은 피사체를 쓰는 것은 드물지 않다
 * (둘 다 카드형이면 자리가 `첫 장` 으로 겹친다). 그때 키가 같으면 한쪽이 그린 그림이
 * 다른 쪽 프레임에 조용히 걸린다 — 오류도 로그도 없다.
 *
 * ⚠️ **셀러형(`CONTENT_GUIDE`)은 유형 토큰을 붙이지 않는다. 대칭으로 "정리"하지 말 것.**
 * 이 비대칭은 실수가 아니라 **레거시 네임스페이스 보존**이다. 셀러형이 곧 `kind` 의
 * 스키마 기본값(`@default("CONTENT_GUIDE")`)이고, 지금 저장돼 있는 시안은 전부 그
 * 유형이다. 여기에 토큰을 붙이면 기존 키가 전부 바뀌어 **멀쩡한 그림이 통째로
 * 고아가 된다** — 오류 없이 프레임만 비는 #232 와 똑같은 실패 모드이고, 되살리려면
 * 프로덕션 쓰기(`scripts/rekey-guide-sketches.ts --apply`, 오너 게이트)가 필요하다.
 * 새 유형만 자기 네임스페이스를 가지면 충돌 방지라는 목적은 그대로 달성된다.
 *
 * 자리(`slot`)와 피사체(`subject`)만 넣는 것은 종전 그대로다. `why`(이 컷이 하는 일)는
 * **그림에 영향을 주지 않으므로** 키에서 뺀다 — 넣으면 카피만 다듬어도 캐시가 깨져 돈이
 * 나간다. 번호(`no`)도 뺀다: 컷 순서만 바뀐 경우 같은 그림을 다시 그릴 이유가 없다.
 */
export function cutSketchKey(
  cut: GuideCut,
  kind: GuideKind = DEFAULT_GUIDE_KIND,
): string {
  const namespace = kind === "CONTENT_GUIDE" ? "" : `${kind}|`;
  const basis = `${SKETCH_PROMPT_VERSION}|${namespace}${cut.slot.trim()}|${cut.subject.trim()}`;
  return cacheKeyHex(basis);
}

/**
 * 컷의 매체 — 영상 컷인가 카드뉴스 한 장인가.
 *
 * 자리(`slot`) 표기로 가른다: 프롬프트가 영상은 `0~3초`, 이미지·글 채널은 `첫 장`·`2장`
 * 을 쓰도록 지시하기 때문이다. 종전에는 **모든 컷을 영상으로 조립**해 카드뉴스 컷에도
 * `shot N of a short-form vertical video` 가 붙었다(실측 2026-08-02) — 매체가 틀리면
 * 모델이 그리는 화면 구성 자체가 어긋난다.
 */
export type SketchMedium = "VIDEO" | "CARD";
export function cutMedium(cut: GuideCut): SketchMedium {
  return /장\s*$/.test(cut.slot.trim()) ? "CARD" : "VIDEO";
}

/** 그림에 넣을 상품 정체. 없으면 모델이 카테고리를 지어낸다(실측: 쥬얼리 딜에 화장품). */
export type SketchProduct = { name: string; category: string | null };

/**
 * 컷 하나의 그림 지시문.
 *
 * 배치 순서가 설계다 — **피사체 → 배경 → UI 형상 → 스타일 락**. 서두 가중치가 가장
 * 크므로 그 자리를 상품과 장면이 갖고, 스타일은 후반에 둔다(종전에는 정반대로 스타일
 * 락이 맨 앞이고 그릴 대상이 뒤에 있었다).
 *
 * ⚠️ **서비스명(Instagram 등)을 부르지 않는다.** 비교 생성에서 이름을 부른 쪽은 실제
 * UI 를 정확히 재현하는 대신 라벨 글자까지 함께 그렸다. 아이콘을 **빈 윤곽 형상**으로
 * 서술하면 레이아웃은 얻고 글자는 오지 않는다(2026-08-02 실측, 2연속 재현).
 */
/**
 * 컷 서술이 화면 글자를 요구하는가 — `자막과 함께`·`훅 문구 배치` 같은 표현.
 *
 * 실측(2026-08-02): 이런 컷에서 모델이 **지어낸 한글 카피를 그림에 렌더**했다
 * ("나를 빛내줄, 쥬얼리 컬렉션" — 우리 가이드에 없는 문구다). 스타일 락이 "모든 면은
 * 비어 있다"고 해도 **장면 서술이 앞에 있어 이긴다.** 가이드에 없는 문구가 이미지로
 * 나가면 표시광고 측면에서 근거 없는 시각 주장이 된다.
 *
 * 그래서 이 경우에만 **자리를 비우라는 지시**를 장면 바로 뒤에 덧댄다. 항상 넣지
 * 않는 이유는 글자 관련 어휘를 불필요하게 노출하면 그 자체가 그려질 후보가 되기
 * 때문이다(Pink Elephant).
 */
const TEXT_CUE = /자막|문구|텍스트|카피|타이틀|제목|안내\s*문/;
export function cutAsksForOnScreenText(cut: GuideCut): boolean {
  return TEXT_CUE.test(cut.subject);
}

export function buildSketchPrompt(cut: GuideCut, product: SketchProduct): string {
  const medium = cutMedium(cut);
  const subject = `${product.name.trim()}${product.category ? ` (${product.category.trim()})` : ""}`;
  const frame =
    medium === "VIDEO"
      ? "The whole frame is drawn as a phone screen for a vertical video app: a column of three small plain rounded icon outlines down the right edge, and a slim rounded bar across the bottom edge, all sketched in the same loose pencil line and left as empty outlines."
      : "The whole frame is drawn as a single card in a phone photo-feed post: a slim rounded bar across the bottom edge with a short row of small plain dot outlines above it, all sketched in the same loose pencil line and left as empty outlines.";

  return [
    medium === "VIDEO"
      ? `A rough shot-planning sketch for a short-form vertical video, showing ${subject}.`
      : `A rough layout sketch for one card of a vertical social feed post, showing ${subject}.`,
    `Scene: ${cut.subject.trim()}`,
    ...(cutAsksForOnScreenText(cut)
      ? [
          "The area where the scene places wording stays a calm empty band, so a caption can be laid over it afterwards.",
        ]
      : []),
    "Background is suggested with a few quick strokes, with soft natural daylight falling across the scene.",
    frame,
    SKETCH_STYLE_LOCK,
  ].join("\n");
}

/** 초안에 저장되는 시안 1건. `url` 은 우리 스토리지의 공개 URL이다. */
export type GuideSketch = {
  /** `cutSketchKey` 결과 — 캐시 조회 키. */
  key: string;
  url: string;
};

/** 저장된 시안 목록(JSON 컬럼)을 안전하게 파싱한다. 깨졌으면 빈 배열. */
export function parseStoredSketches(raw: string | null): GuideSketch[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is GuideSketch =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as GuideSketch).key === "string" &&
        typeof (v as GuideSketch).url === "string",
    );
  } catch {
    // 저장값이 깨져도 생성은 계속돼야 한다 — 캐시 미스로 떨어질 뿐이다.
    return [];
  }
}

export type SketchPlan = {
  /** 캐시에 있어 그리지 않아도 되는 것(그대로 재사용). */
  reused: GuideSketch[];
  /** 새로 그려야 하는 컷. */
  toDraw: GuideCut[];
  /**
   * 상한을 넘겨 이번에 그리지 않은 컷의 **키** — 조용히 버리지 않는다(P0).
   * 개수가 아니라 키인 이유: 화면이 "어느 프레임이 미생성인가"를 표시해야 하고,
   * 개수만으로는 빈 프레임과 구분이 안 된다(2026-08-01 오너 지적).
   */
  skippedKeys: string[];
};

/**
 * 컷 목록과 저장된 시안을 대조해 "그릴 것"과 "재사용할 것"을 가른다.
 *
 * 중복 키는 한 번만 그린다(모델이 같은 장면을 두 컷에 낼 수 있다).
 * 상한은 **새로 그리는 것**에만 건다 — 캐시 재사용은 비용이 0이라 막을 이유가 없다.
 */
export function planSketches(
  cuts: GuideCut[],
  stored: GuideSketch[],
  max: number = MAX_SKETCHES_PER_GUIDE,
  kind: GuideKind = DEFAULT_GUIDE_KIND,
): SketchPlan {
  const cache = new Map(stored.map((s) => [s.key, s]));
  const reused: GuideSketch[] = [];
  const toDraw: GuideCut[] = [];
  const seen = new Set<string>();
  const skippedKeys: string[] = [];

  for (const cut of cuts) {
    const key = cutSketchKey(cut, kind);
    if (seen.has(key)) continue;
    seen.add(key);

    const hit = cache.get(key);
    if (hit) {
      reused.push(hit);
      continue;
    }
    if (toDraw.length >= max) {
      skippedKeys.push(key);
      continue;
    }
    toDraw.push(cut);
  }

  return { reused, toDraw, skippedKeys };
}

/**
 * 갱신된 시안 목록을 만든다 — **이번 컷에 해당하는 것만 남긴다.**
 * 컷이 바뀌어 쓰이지 않게 된 시안은 목록에서 빠진다(스토리지 객체는 남지만
 * 512px JPEG 이라 무시할 수준이고, 되살아날 컷이면 같은 키로 다시 붙는다).
 */
export function mergeSketches(
  cuts: GuideCut[],
  reused: GuideSketch[],
  drawn: GuideSketch[],
  kind: GuideKind = DEFAULT_GUIDE_KIND,
): GuideSketch[] {
  const byKey = new Map([...reused, ...drawn].map((s) => [s.key, s]));
  const out: GuideSketch[] = [];
  const seen = new Set<string>();
  for (const cut of cuts) {
    const key = cutSketchKey(cut, kind);
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = byKey.get(key);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * 스토리지 경로 — 컷 키가 경로에 들어가 같은 컷이면 같은 객체를 덮어쓴다.
 *
 * 유형 네임스페이스는 **키와 같은 규칙**을 따른다(셀러형은 레거시 평면 경로, 새 유형은
 * 하위 디렉터리). 규칙을 한 번만 정해 두 자리에 똑같이 적용하는 것이 요점이다 —
 * 경로만 갈라 두면 "어느 쪽이 진짜 네임스페이스인가"가 두 개가 된다.
 *
 * ℹ️ 경로가 바뀌어도 기존 시안은 멀쩡하다 — 레코드에 **URL 이 명시적으로** 들어 있어
 * 조회가 경로 이름을 거치지 않는다(`scripts/rekey-guide-sketches.ts` 가 같은 근거로
 * 오브젝트를 옮기지 않는다). 위험한 것은 경로가 아니라 **키** 변경뿐이다.
 */
export function sketchStoragePath(
  dealId: string,
  key: string,
  kind: GuideKind = DEFAULT_GUIDE_KIND,
): string {
  const namespace = kind === "CONTENT_GUIDE" ? "" : `${kind}/`;
  return `deals/${dealId}/sketches/${namespace}${key}.jpg`;
}

/**
 * ── 프레임 표시 상태 ──────────────────────────────────────────────────────
 *
 * 왜 필요한가(오너 지적 2026-08-01): 빈 점선 프레임 하나가 **"그리는 중"·"실패"·
 * "기능 미작동"** 을 전부 뜻해서 구분이 안 됐다. 특히 요청이 통째로 실패해도
 * 화면은 무음이라(`if (!res.ok) return`), 운영자는 기다려야 하는지 포기해야 하는지
 * 알 수 없었다. 상태를 명시적으로 가른다.
 */
export type SketchFrameStatus =
  /** 그려져 있음 — 이미지 표시. */
  | "ready"
  /** 생성 중 — 스켈레톤. */
  | "loading"
  /** 이 컷의 생성이 실패함(다른 컷은 성공했을 수 있다). */
  | "failed"
  /** 상한(`MAX_SKETCHES_PER_GUIDE`)을 넘겨 이번에 그리지 않음. */
  | "skipped"
  /** 이미지 저장소 미설정 등 기능 자체가 꺼져 있음 — 실패와 구분한다. */
  | "unavailable"
  /** 아직 요청하지 않음(초안 복원 직후 등) — 지금까지의 빈 프레임과 같다. */
  | "idle";

/** 화면이 넘겨 주는 시안 진행 상황. */
export type SketchProgress = {
  loading: boolean;
  /** 실패한 컷과 **이유**. 이유가 없으면 화면이 "실패"밖에 못 쓴다. */
  failures: SketchFailure[];
  skippedKeys: string[];
  /**
   * 요청이 통째로 실패한 경우. 컷별 키를 알 수 없으므로 **URL 없는 모든 프레임**에
   * 적용된다. `UNAVAILABLE`(저장소 미설정 503)과 `FAILED`(그 외)를 가르는 이유:
   * 전자는 재시도해도 소용없고 설정 문제라, 운영자가 할 일이 다르다.
   */
  requestError: null | "UNAVAILABLE" | "FAILED";
};

/**
 * 컷 하나의 표시 상태를 판정한다(순수 — 계약 테스트 대상).
 *
 * 우선순위가 중요하다: **이미 그려진 것은 무슨 일이 있어도 `ready`** 다. 재시도 중에
 * 성공분이 스켈레톤으로 되돌아가면 화면이 뒷걸음질친다.
 */
export function sketchFrameStatus(
  key: string,
  hasUrl: boolean,
  progress: SketchProgress | undefined,
): SketchFrameStatus {
  if (hasUrl) return "ready";
  if (!progress) return "idle";
  if (progress.requestError === "UNAVAILABLE") return "unavailable";
  if (progress.failures.some((f) => f.key === key)) return "failed";
  if (progress.skippedKeys.includes(key)) return "skipped";
  if (progress.requestError === "FAILED") return "failed";
  if (progress.loading) return "loading";
  return "idle";
}

/** 프레임 안에 띄울 안내 문구. `ready`·`loading`·`idle` 은 글자를 쓰지 않는다. */
export function sketchFrameLabel(
  key: string,
  status: SketchFrameStatus,
  progress: SketchProgress | undefined,
): string | null {
  if (status !== "failed") return SKETCH_STATUS_LABEL[status];
  // 이유를 아는 실패는 처방까지 적는다. 요청 통째 실패(키 미상)는 일반 문구.
  const hit = progress?.failures.find((f) => f.key === key);
  return hit ? SKETCH_FAILURE_LABEL[hit.reason] : SKETCH_STATUS_LABEL.failed;
}

export const SKETCH_STATUS_LABEL: Record<SketchFrameStatus, string | null> = {
  ready: null,
  loading: null,
  idle: null,
  failed: "시안 생성 실패",
  skipped: `시안은 컷 ${MAX_SKETCHES_PER_GUIDE}개까지만 그립니다`,
  unavailable: "이미지 저장소가 설정되지 않았습니다",
};

/**
 * ── 실패 이유 ─────────────────────────────────────────────────────────────
 *
 * "시안 생성 실패" 한 줄로는 디버깅이 안 된다(오너 지적 2026-08-01) — **운영자가
 * 할 일이 이유마다 다르기 때문**이다: 지출 상한은 결제 콘솔, 안전 필터는 컷 문구,
 * 저장 실패는 인프라, 일시 한도는 그냥 재시도다.
 *
 * ⚠️ **원문 오류 메시지를 화면에 올리지 않는다**(P0). Gemini 오류 본문에는 요청 URL
 * (`?key=…`)이 에코될 수 있어 `redactGeminiSecrets` 를 거쳐도 화면 노출은 위험을
 * 감수할 이유가 없다. 화면에는 **분류 라벨만**, 원문은 `ApiCallLog` 와 서버 로그에.
 */
export type SketchFailureReason =
  /** 429 + 상한 표현 — 재시도로 낫지 않는다. 결제 콘솔에서 풀어야 한다. */
  | "SPEND_CAP"
  /** 429 일시 폭주 — 잠시 후 재시도하면 된다. */
  | "RATE_LIMITED"
  /** 호출은 됐는데 이미지가 없다(안전 필터 등) — 컷 문구를 손보면 될 수 있다. */
  | "NO_IMAGE"
  /** 그림은 받았는데 우리 스토리지 업로드가 실패 — 인프라 문제. */
  | "UPLOAD"
  /** 응답 전 실패(타임아웃·DNS). */
  | "NETWORK"
  /**
   * 400 — 요청 형식이 거부됐다. **모델·파라미터 배선 문제라 재시도가 무의미하고
   * 개발자가 고쳐야 한다.** 실사고 2026-08-01: `delivery:"inline"` 이 SDK 타입에는
   * 있는데 서버가 `Image delivery mode is not supported` 로 거부해 전 컷이 죽었다.
   * 그때 이 분류가 없어 `UNKNOWN` 으로 떨어졌고 화면이 처방을 못 냈다.
   */
  | "BAD_REQUEST"
  | "UNKNOWN";

/** 실패한 컷 하나. 화면이 프레임 밑에 라벨로 쓴다. */
export type SketchFailure = { key: string; reason: SketchFailureReason };

/** 생성 단계 — 같은 오류 문자열이라도 어느 단계인지에 따라 처방이 다르다. */
export type SketchStep = "GENERATE" | "UPLOAD";

/**
 * 오류를 처방 가능한 이유로 분류한다(순수 — 계약 테스트 대상).
 * 판정 근거는 **status 우선, 그다음 메시지**다. 메시지만 보면 본문에 우연히 섞인
 * 단어에 끌려간다.
 */
export function classifySketchFailure(
  step: SketchStep,
  err: unknown,
): SketchFailureReason {
  if (step === "UPLOAD") return "UPLOAD";

  const status = (err as { status?: unknown })?.status;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";

  if (status === 400 || /\b400\b/.test(message)) return "BAD_REQUEST";
  if (status === 429 || /\b429\b/.test(message)) {
    // 429 는 "잠깐 몰렸다"와 "이번 달 예산이 끝났다"가 같은 코드다 — 사유 문자열로 가른다
    // (`gemini-usage` 의 `spendCapSuspected` 와 같은 판정 기준을 쓴다).
    return /spending cap|quota|RESOURCE_EXHAUSTED/i.test(message)
      ? "SPEND_CAP"
      : "RATE_LIMITED";
  }
  // 응답은 왔는데 이미지가 없는 경우 — `extractInlineImage` 가 던지는 형태.
  if (/output_image|inline 데이터|바이트가 비정상/.test(message)) return "NO_IMAGE";
  if (/network|fetch failed|timeout|ETIMEDOUT|ECONNRESET|aborted/i.test(message)) {
    return "NETWORK";
  }
  return "UNKNOWN";
}

/**
 * 프레임에 쓸 이유 라벨. **원문이 아니라 처방**을 적는다 — 운영자가 다음에 뭘 해야
 * 하는지가 곧 이 문자열의 값어치다.
 */
export const SKETCH_FAILURE_LABEL: Record<SketchFailureReason, string> = {
  SPEND_CAP: "시안 실패 · Gemini 지출 상한 초과",
  RATE_LIMITED: "시안 실패 · 일시 한도 초과, 잠시 후 다시",
  NO_IMAGE: "시안 실패 · 모델이 이미지를 주지 않음",
  UPLOAD: "시안 실패 · 이미지 저장 실패",
  NETWORK: "시안 실패 · 네트워크 오류",
  BAD_REQUEST: "시안 실패 · 요청 형식 오류(배선 확인 필요)",
  UNKNOWN: "시안 생성 실패",
};

/** 단계를 실어 던지는 오류 — 분류가 `catch` 지점에서 단계를 잃지 않게 한다. */
export class SketchStepError extends Error {
  constructor(
    readonly step: SketchStep,
    override readonly cause: unknown,
  ) {
    super(`시안 ${step} 단계 실패`);
    this.name = "SketchStepError";
  }
}
