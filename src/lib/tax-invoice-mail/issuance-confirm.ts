/**
 * 발행 자동 확정의 **쓰기 계획** 수립 — 순수 함수. DB 를 쓰지 않는다.
 *
 * 판정(`issuance-match.ts`)과 쓰기(크론 라우트)를 잇는 얇은 계층이다. 이 계층을 따로 두는
 * 이유는 이 트랙 최초의 쓰기 경로이기 때문이다 — **무엇을 쓸지 결정하는 규칙**을 순수
 * 함수로 격리해야 계약 테스트가 "가드를 빼면 실제로 실패하는가"를 변이 실증으로 확인할 수
 * 있다. 라우트 안에 인라인으로 두면 그 실증이 IMAP·Prisma 목킹에 묶인다.
 *
 * ## ⛔ 찍는 방향만 한다 — 지우지 않는다
 *
 * 메일 커버리지가 100% 가 아님이 실측됐다(오너가 실물 계산서를 제시한 건의 국세청 메일을
 * 편지함 15개 폴더 전수로 찾았으나 0건). 그래서 "메일이 없으니 발행 취소"로 되돌리면
 * **커버리지 구멍이 곧 데이터 손상**이 된다. 이 함수는 `null` 로 되돌리는 op 를 **만들 수
 * 없다** — 타입 자체가 날짜를 필수로 요구한다.
 */

import type { ExpectedIssuance, IssuanceTrackingField } from "./expected-issuances";
import type { IssuanceMatchBasis, IssuanceVerdict } from "./issuance-match";

export type IssuanceWriteTargetResolved =
  | { kind: "campaign"; campaignId: string }
  | { kind: "group"; groupId: string };

export interface IssuanceWriteOp {
  /** 기대 건 키 — 역추적용 */
  key: string;
  target: IssuanceWriteTargetResolved;
  field: IssuanceTrackingField;
  /**
   * 찍을 날짜 = **계산서 작성일자**(`YYYY-MM-DD`). 스캔한 날이 아니다 — 필드의 뜻이
   * "계산서 발행일"이고, 오너가 수동으로 찍던 값과 같은 성격이어야 한다.
   */
  writtenDate: string;
  /** 감사 로그에 남길 근거 */
  evidence: {
    issueIds: string[];
    invoiceCount: number;
    totalAmount: number | null;
    expectedTotalAmount: number | null;
    basis: IssuanceMatchBasis[];
    /**
     * 허용오차로 **흡수한** 차액(원). 0 이면 완전 일치라 `null` 로 둔다.
     *
     * ⛔ 이 값을 응답에만 싣고 끝내지 말 것 — 응답은 휘발되고, 나중에 "이 날짜가 왜
     * 찍혔나 · 그 차액이 절삭이었나 입력 오류였나"를 되짚을 때 남는 것은 캠페인
     * 타임라인뿐이다. 쓰기 경로라 사후 감사 경로가 필요하다(오너 요구 2026-08-06).
     */
    toleratedDelta: number | null;
  };
  /** 이 확정이 덮는 캠페인 전부 — 감사 로그를 캠페인마다 남기기 위해 필요하다 */
  campaignIds: string[];
  /** ⚠️ 셀러 실명이 들어갈 수 있다 — 응답·로그 취급 주의(P0) */
  campaignLabel: string;
}

export type SkipCode =
  /** 판정이 `CONFIRMED` 가 아니다(사유는 verdict 에 있다) */
  | "NOT_CONFIRMED"
  /** 자동 확정 쓰기 대상이 없다(그룹이 캠페인별로 후퇴) */
  | "NO_WRITE_TARGET"
  /** 작성일자가 없어 찍을 값이 없다 */
  | "NO_WRITTEN_DATE"
  /** 같은 대상·같은 필드에 서로 다른 날짜를 쓰려는 계획이 둘 이상이다 */
  | "CONFLICTING_TARGET";

export interface SkippedWrite {
  key: string;
  code: SkipCode;
}

export interface IssuanceWritePlan {
  ops: IssuanceWriteOp[];
  skipped: SkippedWrite[];
}

/** `${kind}:${id}:${field}` — 같은 필드를 두 계획이 다투는지 판별하는 키. */
function targetKey(target: IssuanceWriteTargetResolved, field: IssuanceTrackingField): string {
  return target.kind === "group"
    ? `group:${target.groupId}:${field}`
    : `campaign:${target.campaignId}:${field}`;
}

/**
 * 판정 결과에서 실제로 쓸 것만 골라 계획을 만든다.
 *
 * 통과 조건은 `matchIssuedInvoices` 가 이미 전부 검사했다 — 여기서 다시 유도하지 않고
 * `status === "CONFIRMED"` 를 그대로 믿는다(두 번째 인코딩을 만들지 않는다). 이 함수가
 * 추가로 보는 것은 **쓰기가 물리적으로 가능한가** 세 가지뿐이다: 대상이 있는가 · 찍을
 * 날짜가 있는가 · 같은 자리를 두 계획이 다투지 않는가.
 */
export function buildIssuanceWritePlan(
  verdicts: readonly IssuanceVerdict[],
  expected: readonly ExpectedIssuance[],
): IssuanceWritePlan {
  const byKey = new Map(expected.map((item) => [item.key, item]));
  const ops: IssuanceWriteOp[] = [];
  const skipped: SkippedWrite[] = [];

  for (const verdict of verdicts) {
    const item = byKey.get(verdict.key);
    if (!item) continue;

    if (verdict.status !== "CONFIRMED") {
      // UNSEEN·UNMATCHABLE 은 "아직 없다"이지 실패가 아니다 — 소음이 되지 않게 계획
      // 밖으로만 두고 사유는 verdict 가 이미 갖고 있다.
      if (verdict.status === "NEEDS_REVIEW") skipped.push({ key: verdict.key, code: "NOT_CONFIRMED" });
      continue;
    }

    if (item.writeTarget === null) {
      // `matchIssuedInvoices` 가 이 경우를 이미 NEEDS_REVIEW 로 내리므로 정상 경로에서는
      // 도달하지 않는다. 그래도 남겨 둔다 — 판정 쪽 가드가 미래에 느슨해지면 여기가
      // 마지막 방벽이고, 이 줄이 없으면 그 완화가 **조용히** 그룹 전체를 찍는다.
      skipped.push({ key: verdict.key, code: "NO_WRITE_TARGET" });
      continue;
    }

    const writtenDate = verdict.observed.writtenDate;
    if (!writtenDate) {
      skipped.push({ key: verdict.key, code: "NO_WRITTEN_DATE" });
      continue;
    }

    ops.push({
      key: verdict.key,
      target: item.writeTarget,
      field: item.trackingField,
      writtenDate,
      evidence: {
        issueIds: verdict.assigned
          .map((a) => a.issueId)
          .filter((id): id is string => id !== null),
        invoiceCount: verdict.assigned.length,
        totalAmount: verdict.observed.totalAmount,
        expectedTotalAmount: verdict.observed.expectedTotalAmount,
        basis: [...new Set(verdict.assigned.map((a) => a.basis))],
        // 판정이 이미 「흡수했다」를 사유로 선언했다 — 여기서 다시 유도하지 않고 그 사실을
        // 그대로 믿는다(두 번째 인코딩을 만들지 않는다).
        toleratedDelta: verdict.reasons.some((r) => r.code === "AMOUNT_TOLERATED")
          ? verdict.observed.amountDelta
          : null,
      },
      campaignIds: item.campaignIds,
      campaignLabel: item.campaignLabel,
    });
  }

  // ── 같은 자리를 다투는 계획은 **둘 다 버린다.** 하나를 고르면 그 선택 기준이 어디에도
  //    적혀 있지 않은 채로 프로덕션 데이터를 바꾸게 된다.
  const seen = new Map<string, IssuanceWriteOp[]>();
  for (const op of ops) {
    const key = targetKey(op.target, op.field);
    const bucket = seen.get(key);
    if (bucket) bucket.push(op);
    else seen.set(key, [op]);
  }

  const safe: IssuanceWriteOp[] = [];
  for (const bucket of seen.values()) {
    const dates = new Set(bucket.map((op) => op.writtenDate));
    if (bucket.length === 1 || dates.size === 1) {
      // 같은 날짜라면 결과가 같으므로 하나만 실행한다(멱등).
      safe.push(bucket[0]);
    } else {
      for (const op of bucket) skipped.push({ key: op.key, code: "CONFLICTING_TARGET" });
    }
  }

  return { ops: safe, skipped };
}
