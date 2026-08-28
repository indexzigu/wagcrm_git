import { Badge } from "@/components/ui/badge";

/**
 * 가격표 처리 파이프라인의 상태 배지.
 *
 * ⛔ **네이비(`status-active`)는 이 표에 쓰지 않는다** (오너 승인 2026-08-26).
 * P8 §4 는 브랜드 네이비 틴트를 "중립 태그 캐리어"로만 허용하고 판정·생애주기
 * 의미로 쓰는 것을 금지한다. 종전에 REVIEWED·APPLIED 가 네이비였는데, 생애주기
 * SSOT(`crm/status-badge.tsx`)에서 네이비는 ACTIVE(=**진행 중**)라 "끝났다"에
 * 정반대 색을 칠하고 있었다. 비서 표면의 같은 위반은 PR #489 로 먼저 고쳤다.
 *
 * ⛔ **「완료」 어휘가 붙었다고 초록을 주지 않는다** — 초록은 **종착점 하나**의 것이다.
 * 이 사다리에서 딜에 실제로 반영된 APPLIED 만 종착점이고, 검수완료는 "검수는 끝났고
 * 아직 반영 안 됨"이다. 생애주기 SSOT 가 이미 같은 문법을 쓴다: CLOSED(마감)는
 * 끝난 것처럼 들려도 무채색이고 COMPLETED 만 `status-success` 다.
 * 추출·매핑·검수 세 단계가 같은 파랑을 공유하는 것은 회귀가 아니라 그 SSOT 와 같은
 * 설계다(배지는 작아서 구간은 색이, 단계는 라벨이 나른다).
 *
 * 어휘는 `apply-result-card.tsx`(반영 중=pending / 반영 완료=success / 반영 실패=urgent)에
 * 맞춘다 — 종전에는 같은 화면에서 「반영완료」가 카드는 초록, 배지는 네이비였다.
 */
const STATUS_LABEL: Record<string, string> = {
  UPLOADED: "업로드됨",
  EXTRACTED: "추출완료",
  MAPPED: "매핑완료",
  REVIEWED: "검수완료",
  // APPLYING 은 반영 API 가 CAS 선점에 쓰는 실제 런타임 값이다
  // (`app/api/price-sheets/[id]/apply/route.ts`). 표에 없어서 화면에 영문
  // "APPLYING" 이 그대로 노출됐다 — ⛔ 다시 빼지 말 것.
  APPLYING: "반영 중",
  APPLIED: "반영완료",
  EXTRACT_FAILED: "추출실패",
};

const STATUS_VARIANT: Record<
  string,
  "status-pending" | "status-info" | "status-success" | "status-urgent"
> = {
  UPLOADED: "status-pending",
  EXTRACTED: "status-info",
  MAPPED: "status-info",
  REVIEWED: "status-info",
  APPLYING: "status-pending",
  APPLIED: "status-success",
  EXTRACT_FAILED: "status-urgent",
};

export function PriceSheetStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "status-pending"}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/**
 * 검수 표의 행 단위 매핑 상태 배지.
 *
 * ⛔ **매핑확정 vs 신규 딜은 우열이 아니라 갈래다** — 기존 딜에 붙이느냐 새 딜을
 * 만드느냐의 경로 선택이지 등급이 아니다(P8 §4 「범주는 색을 받지 않는다」).
 * 종전에 매핑확정만 네이비여서 "그쪽이 더 나은 선택"이라는 없는 위계를 만들었다.
 * 둘을 같은 `status-info` 로 맞춰 **표에서 색으로 튀는 것은 아직 사람이 정하지 않은
 * 「제안됨」 하나만** 남긴다(§3 「표는 주의가 필요한 소수만」 — 이 배지는 행마다
 * 반복되므로 다 칠하면 아무것도 안 튄다).
 *
 * ⛔ 매핑확정을 다시 네이비로 올리지 말 것 — 근거는 위 `STATUS_LABEL` 주석과 같다.
 */
const MAPPING_LABEL: Record<string, string> = {
  UNMAPPED: "미매핑",
  SUGGESTED: "제안됨",
  MAPPED: "매핑확정",
  NEW_DEAL: "신규 딜",
  // 반영 API 가 반영된 행을 이 값으로 전이시킨다(같은 라우트) — 표에 없어서 화면에
  // 영문 "APPLIED" 가 그대로 노출됐다. 시트 단위 종착점과 같은 색 어휘를 쓴다.
  APPLIED: "반영완료",
};

const MAPPING_VARIANT: Record<
  string,
  "status-pending" | "status-info" | "status-success" | "outline"
> = {
  UNMAPPED: "outline",
  SUGGESTED: "status-pending",
  MAPPED: "status-info",
  NEW_DEAL: "status-info",
  APPLIED: "status-success",
};

export function MappingStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={MAPPING_VARIANT[status] ?? "outline"}>
      {MAPPING_LABEL[status] ?? status}
    </Badge>
  );
}
