---
type: reference
title: 용어 동의어 사전 (에이전트 런타임용)
description: 가격표 열 매핑, 자연어 질의 해석 시 참고하는 동의어 힌트. 확정 매핑은 columnMapping(PriceSheet)에 근거를 남긴다 (R4).
timestamp: "2026-07-06"
---

# 용어 동의어 사전

이 문서는 힌트일 뿐 확정 매핑 근거가 아니다. 실제 열 매핑은 `PriceSheet.columnMapping`에 LLM이 판단한 근거와 함께 기록되어야 하며(R4), 이 glossary는 후보 제시 용도로만 쓴다.

## 가격 관련

| 동의어 | 정규화 필드 | 비고 |
|---|---|---|
| 공구가, 공동구매가, 공구할인가, 판매가 | `sellingPrice` | 최종 소비자 판매가 |
| 수수료율, R.S, R/S, 판매수수료율 | `commissionRate` | 셀러/채널 수수료율 |
| 공급가, 밴더사공급가, 정산가, 셀러가 | `supplyPrice` | 벤더가 셀러/CRM 측에 공급하는 원가성 가격 |
| 정가, 소비자가, 리스트가 | `listPrice` | 할인 전 정가 |
| 마지노선가, 하한가, 최저가 | `floorPrice` | 협상 가능한 최저 판매가 |
| 할인율, 세일율 | `discountRate` | listPrice 대비 할인율 |

## 상태/분류 관련

| 동의어 | 정규화 필드/값 | 비고 |
|---|---|---|
| 사은품, 증정품 | `PriceSheetRow.flags`(사은품 플래그) | 단가 없이 별도 표기되는 경우가 많음 |
| 단독구매불가, 단품구매불가 | `PriceSheetRow.flags`(단독구매불가 플래그) | 세트 구성 상품에 흔함 |
| 음수마진, 마진역전 | `PriceSheetRow.flags`(음수마진 플래그) | sellingPrice - supplyPrice < 0 감지 시 |
| 미매핑, 매핑안됨 | `mappingStatus=UNMAPPED` | |
| 매핑완료, 확정매핑 | `mappingStatus=MAPPED` | |
| 신규딜, 신규상품 | `mappingStatus=NEW_DEAL` | 기존 Deal에 대응 없음 |

## 요청/승인 관련

| 동의어 | 정규화 필드/값 | 비고 |
|---|---|---|
| 초안, 임시안 | `ActionProposal.status=DRAFT` | |
| 승인대기, 검토중 | `status=PENDING_APPROVAL` | |
| 실행완료, 처리완료 | `status=EXECUTED` | |
| 반려, 거절 | `status=REJECTED` | |
| 실패, 오류 | `status=FAILED` | |
| 조회성 산출물, 리포트 | `kind=READ` | |
| 실행 기안, 변경 요청 | `kind=WRITE` | |

## 소통 기록 관련

| 동의어 | 정규화 필드/값 | 비고 |
|---|---|---|
| 카톡, 카카오톡 | `WorkRecord.source=KAKAO` | |
| 메일, 이메일 | `WorkRecord.source=EMAIL` | |
| 메모, 노트 | `WorkRecord.source=MEMO` | |
| 자동귀속 | `attributedBy=AUTO` | ChatRoomMapping 존재 시 |
| 수동귀속, 수기지정 | `attributedBy=MANUAL` | |
