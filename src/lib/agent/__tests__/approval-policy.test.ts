/**
 * approval-policy 단위 테스트 (Phase 5 자동승인 화이트리스트 청사진 v2 §2, §6).
 *
 * getRequestTypeForAction: action → requestType 매핑(§1, 미등록 시 fail-closed "crm_mutation").
 * isAutoApprovable: 킬스위치 off && alwaysManual에 없음 && autoApprove에 (requestType,kind) 일치.
 *
 * ⚠️ 킬스위치(AUTO_APPROVE_DISABLED)는 함수 본문에서 매 호출 읽어야 하므로(모듈 상수 캡처 금지),
 * env를 테스트 중간에 바꿔가며 즉시 반영되는지도 검증한다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import approvalRulesJson from "../../../../knowledge/rules/approval.rules.json";
import {
  getRequestTypeForAction,
  isAutoApprovable,
  REQUEST_TYPE_BY_ACTION,
} from "../approval-policy";

describe("getRequestTypeForAction", () => {
  it("add_entity_memo → campaign_note_add", () => {
    expect(getRequestTypeForAction("add_entity_memo")).toBe("campaign_note_add");
  });

  it("change_deal_status → crm_mutation", () => {
    expect(getRequestTypeForAction("change_deal_status")).toBe("crm_mutation");
  });

  it("confirm_settlement → settlement_confirm", () => {
    expect(getRequestTypeForAction("confirm_settlement")).toBe("settlement_confirm");
  });

  it("미등록 action → fail-closed로 crm_mutation을 반환한다", () => {
    expect(getRequestTypeForAction("delete_everything")).toBe("crm_mutation");
    expect(getRequestTypeForAction("")).toBe("crm_mutation");
  });
});

describe("isAutoApprovable", () => {
  const ORIGINAL_ENV = process.env.AUTO_APPROVE_DISABLED;

  beforeEach(() => {
    delete process.env.AUTO_APPROVE_DISABLED;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.AUTO_APPROVE_DISABLED;
    } else {
      process.env.AUTO_APPROVE_DISABLED = ORIGINAL_ENV;
    }
  });

  it("settlement_confirm(alwaysManual)은 WRITE라도 false다", () => {
    expect(isAutoApprovable("settlement_confirm", "WRITE")).toBe(false);
  });

  it("crm_mutation(alwaysManual)은 WRITE라도 false다", () => {
    expect(isAutoApprovable("crm_mutation", "WRITE")).toBe(false);
  });

  it("campaign_note_add + WRITE → true (autoApprove 등재)", () => {
    expect(isAutoApprovable("campaign_note_add", "WRITE")).toBe(true);
  });

  it("campaign_note_add + READ → false (kind 불일치)", () => {
    expect(isAutoApprovable("campaign_note_add", "READ")).toBe(false);
  });

  it("미지 requestType → false (fail-closed)", () => {
    expect(isAutoApprovable("never_registered_request_type", "WRITE")).toBe(false);
  });

  it("양쪽 등재(오설정) 시 alwaysManual이 승리한다", () => {
    // rules 객체를 주입 가능한 오버로드로 실제 오설정 상태(동일 requestType이
    // autoApprove와 alwaysManual 양쪽에 모두 있는 경우)를 재현한다.
    const conflictingRules = {
      autoApprove: [{ requestType: "conflict_type", kind: "WRITE" as const }],
      alwaysManual: [{ requestType: "conflict_type" }],
    };
    expect(isAutoApprovable("conflict_type", "WRITE", conflictingRules)).toBe(false);
  });

  it("AUTO_APPROVE_DISABLED=1이면 원래 자동승인 대상이었던 조합도 무조건 false다", () => {
    process.env.AUTO_APPROVE_DISABLED = "1";
    expect(isAutoApprovable("campaign_note_add", "WRITE")).toBe(false);
  });

  it("킬스위치는 모듈 상수 캡처가 아니라 매 호출 시 읽는다 — 같은 테스트 내에서 env를 바꾸면 즉시 반영된다", () => {
    expect(isAutoApprovable("campaign_note_add", "WRITE")).toBe(true);
    process.env.AUTO_APPROVE_DISABLED = "1";
    expect(isAutoApprovable("campaign_note_add", "WRITE")).toBe(false);
    delete process.env.AUTO_APPROVE_DISABLED;
    expect(isAutoApprovable("campaign_note_add", "WRITE")).toBe(true);
  });
});

describe("매핑↔rules 동기화 가드 (load-bearing)", () => {
  it("REQUEST_TYPE_BY_ACTION의 모든 값은 실제 approval.rules.json의 autoApprove∪alwaysManual requestType 집합에 존재해야 한다", () => {
    const knownRequestTypes = new Set<string>([
      ...approvalRulesJson.autoApprove.map((r) => r.requestType),
      ...approvalRulesJson.alwaysManual.map((r) => r.requestType),
    ]);

    const mappedRequestTypes = new Set(Object.values(REQUEST_TYPE_BY_ACTION));
    // fail-closed 기본값도 rules 파일에 실존해야 한다(그래야 미등록 action이 실제로 수동으로 막힌다).
    mappedRequestTypes.add("crm_mutation");

    for (const requestType of mappedRequestTypes) {
      expect(knownRequestTypes.has(requestType)).toBe(true);
    }
  });
});
