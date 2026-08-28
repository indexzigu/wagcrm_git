/**
 * 권한 변경 판정 — 라우트에서 분리한 순수 함수다. 여기서 막는 두 가지가
 * "오너가 스스로 잠기는" 사고를 구조적으로 차단한다.
 */
import { isOwnerFloorEmail } from "@/lib/auth-allowlist";
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
  targetEmail: string;
  targetId: string;
  actorEmail: string;
  actorId: string;
  nowIso: string;
}): MutationVerdict {
  const { request, targetEmail, targetId, actorEmail, actorId, nowIso } = args;

  if (isOwnerFloorEmail(targetEmail)) {
    return { ok: false, reason: "오너 계정은 변경할 수 없습니다" };
  }
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

  const metadata: Record<string, unknown> = {
    grantedBy: actorEmail,
    grantedAt: nowIso,
  };
  if (status !== undefined) metadata.status = status;
  if (role !== undefined) metadata.role = role;

  return { ok: true, metadata };
}
