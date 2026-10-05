/**
 * 택배사 이름 → 네이버 발송처리 `deliveryCompanyCode` 변환의 **단일 정본**(client-safe 순수 모듈).
 *
 * 🔴 **모르는 이름을 기본값으로 접지 않는다.** 종전에는 화면(order-dashboard)이 매핑 표를
 * 인라인으로 들고 `|| 'CJGLS'` 로 떨어뜨려, 표에 없는 택배사(또는 빈 값)가 **실제 고객 주문에
 * CJ대한통운으로 등록**됐다. 네이버 발송처리는 외부 쓰기라 등록된 뒤에는 조용히 틀린 채 남는다.
 * 그래서 이 모듈의 계약은 둘이다:
 *   ① 해석 실패는 값이 아니라 **명시적 `ok: false`** 로 돌려준다(기본 코드 없음).
 *   ② 한 묶음에 해석 실패가 **한 건이라도** 있으면 요청 목록을 만들지 않는다(전량 중단).
 *
 * 서버 라우트(`api/naver/dispatch`)도 같은 코드 집합(`isKnownNaverCourierCode`)으로 400 거절한다 —
 * 화면을 거치지 않는 호출이 임의 코드를 싣는 길을 막는 2차 방어다.
 *
 * ⚠️ 별칭은 **이미 지원하던 택배사의 표기 변형**만 추가한다. 새 택배사를 넣으려면 네이버 코드를
 * 실응답·공식 문서로 확인한 뒤 넣을 것(추측으로 넣으면 이 모듈이 막으려던 오등록이 된다).
 * `롯데택배 → HYUNDAI` 는 오타가 아니라 네이버의 코드 체계다(`claim-derive.ts` 추적 URL 표와 같은 키).
 *
 * xlsx 등 무거운 의존이 없어야 한다 — 클라이언트 번들(order-dashboard)이 값으로 import 한다.
 */
import { normalizeForCompare } from '@/lib/text-normalize';

/** 네이버 코드별 인식 표기. 비교는 NFC·공백 제거·대소문자 무시 후에 한다. */
const COURIER_ALIASES: Record<string, readonly string[]> = {
  CJGLS: ['CJ대한통운', 'CJ택배', '대한통운', 'CJ대한통운택배', '씨제이대한통운'],
  HYUNDAI: ['롯데택배', '롯데', '롯데글로벌로지스'],
  EPOST: ['우체국택배', '우체국', '우체국소포'],
  KGB: ['로젠택배', '로젠'],
  HANJIN: ['한진택배', '한진'],
};

const courierKey = (value: unknown): string =>
  normalizeForCompare(String(value ?? '')).replace(/\s+/g, '').toUpperCase();

const CODE_BY_KEY: ReadonlyMap<string, string> = new Map(
  Object.entries(COURIER_ALIASES).flatMap(([code, names]) =>
    names.map((name) => [courierKey(name), code] as const),
  ),
);

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(COURIER_ALIASES));

export type CourierCodeResolution =
  | { ok: true; code: string }
  | { ok: false; reason: 'empty' | 'unknown'; input: string };

/** 택배사 이름 하나를 네이버 코드로 해석한다. 모르면 `ok: false` — 기본 코드는 없다. */
export function resolveNaverCourierCode(name: unknown): CourierCodeResolution {
  const input = String(name ?? '').trim();
  const key = courierKey(input);
  if (!key) return { ok: false, reason: 'empty', input: '' };
  const code = CODE_BY_KEY.get(key);
  return code ? { ok: true, code } : { ok: false, reason: 'unknown', input };
}

/** 서버 2차 방어용 — 이 모듈이 만들어 낼 수 있는 코드인가. */
export function isKnownNaverCourierCode(code: unknown): boolean {
  return typeof code === 'string' && KNOWN_CODES.has(code);
}

export interface TrackingRecord {
  id: string;
  courier: string;
  tracking: string;
}

export interface NaverDispatchRequest {
  productOrderId: string;
  deliveryMethod: 'DELIVERY';
  deliveryCompanyCode: string;
  trackingNumber: string;
  dispatchDate: string;
}

export type DispatchRequestBuild =
  | { ok: true; requests: NaverDispatchRequest[] }
  | { ok: false; unrecognised: Array<{ courier: string; count: number }>; message: string };

/** 빈 택배사 칸을 토스트에서 부르는 이름. */
export const EMPTY_COURIER_LABEL = '택배사 미기재';

/**
 * 송장 레코드 묶음 → 네이버 발송처리 요청 목록.
 * 해석 못 한 택배사가 한 건이라도 있으면 **요청을 하나도 만들지 않고** 사유 문구를 돌려준다.
 */
export function buildNaverDispatchRequests(
  records: readonly TrackingRecord[],
  dispatchDate: string,
): DispatchRequestBuild {
  const requests: NaverDispatchRequest[] = [];
  const unrecognised = new Map<string, number>();

  for (const r of records) {
    const resolved = resolveNaverCourierCode(r.courier);
    if (!resolved.ok) {
      const label = resolved.reason === 'empty' ? EMPTY_COURIER_LABEL : resolved.input;
      unrecognised.set(label, (unrecognised.get(label) ?? 0) + 1);
      continue;
    }
    requests.push({
      productOrderId: String(r.id).trim(),
      deliveryMethod: 'DELIVERY',
      deliveryCompanyCode: resolved.code,
      trackingNumber: String(r.tracking).trim(),
      dispatchDate,
    });
  }

  if (unrecognised.size > 0) {
    const list = [...unrecognised].map(([courier, count]) => ({ courier, count }));
    return {
      ok: false,
      unrecognised: list,
      message: `택배사를 인식하지 못해 등록을 중단했습니다: ${list
        .map((u) => `${u.courier}(${u.count}건)`)
        .join(', ')}`,
    };
  }
  return { ok: true, requests };
}

// ─────────────────────────────────────────────────────────────────────────────
// 운영자 택배사 선택(오너 확정 2026-10-05)
//
// 해석 못 한 택배사가 있으면 **중단만 하지 않고** 그 자리에서 운영자가 택배사를 고르게 한 뒤
// 이어서 등록한다. 기본값은 여전히 없다 — 고르지 않은 묶음이 하나라도 남으면 아무것도 만들지 않는다.
// 아래 함수들은 그 화면(`courier-choice-dialog.tsx`)과 `order-dashboard` 가 공유하는 순수 로직이다.
// ─────────────────────────────────────────────────────────────────────────────

export interface NaverCourierOption {
  code: string;
  /** 화면·엑셀에 쓰는 대표 표기 — 별칭 표의 첫 항목. */
  label: string;
}

/**
 * 운영자가 고를 수 있는 택배사 = 서버가 받는 코드 집합 그대로(별칭 표에서 파생).
 * ⛔ 여기에 손으로 택배사를 더하지 말 것 — 서버 400 가드와 목록이 갈린다.
 */
export const NAVER_COURIER_OPTIONS: readonly NaverCourierOption[] = Object.entries(COURIER_ALIASES).map(
  ([code, names]) => ({ code, label: names[0] }),
);

const LABEL_BY_CODE: ReadonlyMap<string, string> = new Map(
  NAVER_COURIER_OPTIONS.map((o) => [o.code, o.label] as const),
);

export interface UnresolvedCourierGroup {
  /** 묶음 식별자 — 파일에 적힌 택배사 글자 그대로(앞뒤 공백 제거). 빈 칸은 `''`. */
  key: string;
  /** 화면·작업 기록에 보이는 이름 — 빈 칸은 `택배사 미기재`. */
  label: string;
  count: number;
}

const unresolvedKeyOf = (courier: unknown): string | null => {
  const resolved = resolveNaverCourierCode(courier);
  return resolved.ok ? null : resolved.input;
};

/** 해석 못 한 레코드를 **파일에 적힌 글자 그대로** 묶는다(빈 칸 포함, 첫 등장 순서 유지). */
export function groupUnresolvedCouriers(records: readonly TrackingRecord[]): UnresolvedCourierGroup[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = unresolvedKeyOf(r.courier);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, label: key === '' ? EMPTY_COURIER_LABEL : key, count }));
}

/** 운영자의 선택 — 묶음 key → 네이버 택배사 코드. */
export type CourierChoices = Readonly<Record<string, string>>;

export interface CourierOverride {
  /** 파일에 적혀 있던 글자(빈 칸은 `택배사 미기재`). */
  raw: string;
  code: string;
  count: number;
}

export type CourierChoiceApplication =
  | { ok: true; records: TrackingRecord[]; overrides: CourierOverride[] }
  | { ok: false; missing: UnresolvedCourierGroup[] };

/** 모든 묶음에 **서버가 받는 코드**가 골라졌는가 — 확인 버튼 활성 조건. */
export function isCourierChoiceComplete(
  groups: readonly UnresolvedCourierGroup[],
  choices: CourierChoices,
): boolean {
  return groups.every((g) => isKnownNaverCourierCode(choices[g.key]));
}

/**
 * 운영자의 선택을 **해석 못 한 레코드에만** 입힌다. 이미 인식된 레코드는 손대지 않는다.
 * 선택이 빠졌거나 서버가 받지 않는 코드가 섞이면 레코드를 하나도 돌려주지 않는다(`ok: false`).
 * 돌려주는 레코드의 택배사는 대표 표기라, 그대로 `buildNaverDispatchRequests` 에 넣으면 고른 코드가 된다.
 */
export function applyCourierChoices(
  records: readonly TrackingRecord[],
  choices: CourierChoices,
): CourierChoiceApplication {
  const groups = groupUnresolvedCouriers(records);
  const missing = groups.filter((g) => !isKnownNaverCourierCode(choices[g.key]));
  if (missing.length > 0) return { ok: false, missing };

  const applied = records.map((r) => {
    const key = unresolvedKeyOf(r.courier);
    if (key === null) return r;
    return { ...r, courier: LABEL_BY_CODE.get(choices[key]) as string };
  });
  const overrides = groups.map((g) => ({ raw: g.label, code: choices[g.key], count: g.count }));
  return { ok: true, records: applied, overrides };
}

/**
 * 송장 묶음의 택배사를 확정한다 — 전부 인식되면 묻지 않고 통과, 아니면 `ask` 로 운영자에게 묻는다.
 * `ask` 가 `null`(취소)이나 덜 고른 선택을 돌려주면 `null` — 호출부는 **아무것도 보내지 않고** 끝낸다.
 */
export async function confirmCourierChoices(
  records: readonly TrackingRecord[],
  ask: (groups: UnresolvedCourierGroup[]) => Promise<CourierChoices | null>,
): Promise<{ records: TrackingRecord[]; overrides: CourierOverride[] } | null> {
  const groups = groupUnresolvedCouriers(records);
  if (groups.length === 0) return { records: [...records], overrides: [] };
  const choices = await ask(groups);
  if (!choices) return null;
  const applied = applyCourierChoices(records, choices);
  return applied.ok ? { records: applied.records, overrides: applied.overrides } : null;
}
