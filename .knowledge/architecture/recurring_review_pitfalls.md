---
type: knowledge
title: 반복 리뷰 함정 (구현 전 필독)
description: 독립 리뷰에서 2회 이상 잡힌 패턴 — 신규 기능 스펙·구현 시 사전 체크리스트
timestamp: "2026-07-08T12:00:00+09:00"
---

# 반복 리뷰 함정 — 구현 전 사전 점검

독립 리뷰(react/typescript/database-reviewer)에서 **서로 다른 기능에서 2회 이상 반복 지적**된 패턴들. 신규 기능 구현 에이전트는 코드 작성 전에 이 목록을 자기 diff에 대조할 것.

## 1. 조회→생성 TOCTOU (R2a assign, R5 promote에서 재발)
"중복 확인(findMany/findUnique) 후 create" 시퀀스는 동시 요청에서 둘 다 '없음'을 보고 중복 생성한다.
- **처방**: ① 조건부 원자 연산(claim — `deleteMany/updateMany WHERE 상태조건` 후 count 확인)이 가능하면 최우선 ② 불가하면 `prisma.$transaction(..., { isolationLevel: "Serializable" })` + P2034 캐치 후 재조회 폴백 ③ 근본은 DB unique 제약(후속 티켓: Asset `@@unique([entityType, entityId, externalUrl])` 미도입 상태).
- 실사례: `api/reference-inbox/[id]/assign`(claim 패턴), `api/campaigns/[id]/promote-content`(Serializable).

## 2. 패널 자식 컴포넌트의 엔티티 전환 stale state (R4 딜 전환, R5 캠페인 전환에서 재발)
사이드패널은 리마운트 없이 prop만 갈아끼우는 단일 인스턴스다. 자식이 `useState(initialX)`로 받으면 엔티티(dealId/campaignId) 전환 시 이전 엔티티의 state가 그대로 남는다.
- **처방**: 부모에서 `key={entity.id}`로 강제 리마운트(전 state 일괄 초기화, 우선) 또는 자식의 `[entityId]` useEffect에서 관련 state 전부 리셋.
- 실사례: `deals-panel.tsx` DealAssetSection(가이드 state 리셋), `campaign-side-panel.tsx` AssetManager(key).

## 3. 외부 API 입력 스키마는 실호출로 확정 (R3 Apify 액터, R4 Gemini 토큰에서 연속 실측)
문서·정찰 기반 가정은 틀린다 — Apify 액터별 입력 스키마 상이(`directUrls` 미지원 400), Gemini thinking 토큰이 출력 예산 잠식(잘림).
- **처방**: 외부 API 신규 사용 시 구현 완료 기준에 **실호출 스모크 1회**를 반드시 포함(비용 무시 수준으로 설계). 모킹 테스트만으로 완료 선언 금지.

## 4. 부가 기능은 본류를 깨지 않게 격리 (R2b에서 확립)
인제스트·저장 본류에 붙는 부가 훅(URL 추출 등)은 개별 try/catch로 감싸되 **빈 catch 금지** — 반드시 console.error로 컨텍스트(id·에러) 로깅.

## 5. LLM/외부 응답 필드는 관용(dual-field) 매핑 + unknown 내로잉 (R3·R4)
액터/모델 버전에 따라 필드 위치가 변한다. `a?.b || c` 체인으로 두 형상 수용, falsy 함정은 `??`로(0 보존), `any` 금지.
