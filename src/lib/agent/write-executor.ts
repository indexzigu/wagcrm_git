/**
 * WRITE 액션 실행기 (청사진 §2, §0-3/§0-6) — 배럴.
 *
 * 핸들러 본체·레지스트리는 `./write-actions/`(액션별 파일 + `index.ts` 디스패처)로
 * 분리돼 있다(T-151, 2026-09-11 — main의 이 파일이 800줄 상한에 닿아 핸들러별로
 * 나눴다). 기존 import 경로(`@/lib/agent/write-executor`)는 이 배럴이 그대로
 * 재수출해 유지한다 — 소비처(`executeWriteAction`·`WRITE_ACTIONS`를 쓰는 라우트,
 * `resolveWriteActionEffects`를 쓰는 `write-action-effects.ts`, 테스트)는 고칠 필요가 없다.
 *
 * executeWriteAction은:
 *  ① 화이트리스트 검증(미등록 action은 throw)
 *  ② argsSchema로 args 재검증(승인 시점에 다시 검증 — 기안 생성 이후 스키마가
 *     바뀌었거나 payload가 변조됐을 가능성에 대비)
 *  ③ 대상 엔티티 존재 검증(§0-6, entityType별 findUnique) — 없으면 throw
 *  ④ handler 호출(호출부가 열어둔 tx를 그대로 주입 — 원자성은 호출부 책임)
 *
 * 반환값 {refType, refId, summary}는 ActionProposal.executedRefType/executedRefId/
 * executionResult 기록에 쓰인다.
 */
export type { AddEntityMemoArgs } from "./write-actions/add-entity-memo";
export type { ChangeDealStatusArgs } from "./write-actions/change-deal-status";
export type { ConfirmSettlementArgs } from "./write-actions/confirm-settlement";
export type { CreatePartnerArgs } from "./write-actions/create-partner";
export type { CreateDealArgs } from "./write-actions/create-deal";
export type { WriteActionResult, WriteActionEffectSpec } from "./write-actions/types";
export {
  WRITE_ACTIONS,
  executeWriteAction,
  resolveWriteActionEffects,
  type WriteActionName,
} from "./write-actions";
