/**
 * 권한 변경 판정 — 라우트에서 분리한 순수 함수다. 여기서 막는 두 가지가
 * "오너가 스스로 잠기는" 사고를 구조적으로 차단한다:
 *  ① 자기 계정의 상태·역할은 바꿀 수 없다.
 *  ② 승인된 admin 이 대상 하나뿐이면 강등·거절할 수 없다(관리자 0명 = 아무도 권한을 못 준다).
 * 특정 계정을 이메일로 지목하지 않는다 — 공개 레포에 개인정보를 두지 않기 위해서다
 * (`auth-allowlist.ts` 머리 주석).
 */
import { parseRole, type UserRole } from "@/lib/auth-roles";

export interface MutationRequest {
  status?: "approved" | "rejected";
  role?: UserRole;
}

export type MutationVerdict =
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; reason: string };

export function planMutation(args: {
  request: MutationRequest;
  targetId: string;
  /** 변경 전 시점의 승인된 admin 계정 id 목록(`approvedAdminIds`). */
  approvedAdminIds: readonly string[];
  actorEmail: string;
  actorId: string;
  nowIso: string;
}): MutationVerdict {
  const { request, targetId, approvedAdminIds, actorEmail, actorId, nowIso } = args;

  if (targetId === actorId) {
    return { ok: false, reason: "자기 자신의 권한은 변경할 수 없습니다" };
  }

  const status = request.status;
  if (status !== undefined && status !== "approved" && status !== "rejected") {
    return { ok: false, reason: "알 수 없는 상태입니다" };
  }

  const role = request.role === undefined ? undefined : parseRole(request.role);
  if (request.role !== undefined && role === null) {
    return { ok: false, reason: "알 수 없는 역할입니다" };
  }
  if (status === undefined && role === undefined) {
    return { ok: false, reason: "변경할 내용이 없습니다" };
  }
  if (status === "approved" && role === undefined) {
    return { ok: false, reason: "승인하려면 역할을 함께 지정해야 합니다" };
  }

  const removesAdmin = status === "rejected" || (role !== undefined && role !== "admin");
  const isLastAdmin = approvedAdminIds.length === 1 && approvedAdminIds[0] === targetId;
  if (removesAdmin && isLastAdmin) {
    return { ok: false, reason: "마지막 관리자는 내리거나 거절할 수 없습니다" };
  }

  const metadata: Record<string, unknown> = {
    grantedBy: actorEmail,
    grantedAt: nowIso,
  };
  if (status !== undefined) metadata.status = status;
  if (role !== undefined) metadata.role = role;

  return { ok: true, metadata };
}
