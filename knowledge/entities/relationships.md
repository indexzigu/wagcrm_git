---
type: concept
title: 핵심 엔티티 관계 (에이전트 런타임용)
description: prisma/schema.prisma를 기준으로 작성한 실제 관계 요약. 필드 상세는 스키마가 SSOT이며 이 문서는 관계 해석 힌트다.
timestamp: "2026-07-06"
---

# 핵심 엔티티 관계

## 개요 다이어그램 (텍스트)

```
Partner ──(1:N, referredById 자기참조)── Partner
Partner ──(1:N)── Deal (partnerId)
Partner ──(1:N)── PartnerContact
Partner ──(1:N, "SellerAgency")── Seller (agencyId)
Partner ──(1:N)── PriceSheet (partnerId, nullable)

Seller ──(1:N)── SalesCampaign (sellerId)
Seller ──(1:N)── SellersHistory (팔로워 시계열)
Seller ──(1:N)── SellerOutreach, SalesTask

Deal ──(1:N)── SalesCampaign (dealId)
Deal ──(1:N)── CampaignDeal (dealId)
Deal ──(1:N, "DealOptions" 자기참조)── Deal (parentDealId, MAIN/OPTION)
Deal ──(1:N)── PriceSheetRow (mappedDealId, nullable — 가격표 행이 매핑된 딜)

SalesCampaign ──(N:1)── Deal, Seller (필수 FK)
SalesCampaign ──(1:1)── SettlementChecklist
SalesCampaign ──(1:N)── CampaignDeal, CampaignActivity, CampaignNote,
                        CampaignChecklistItem, Asset, TrackingAttribution
SalesCampaign ──(1:N)── ActionProposal (campaignId, nullable)
SalesCampaign ──(1:N)── WorkRecord (campaignId, nullable)

CampaignDeal ──(N:1)── SalesCampaign, Deal (한 캠페인 안에 여러 딜/옵션이 걸릴 때의 조인 테이블)
CampaignDeal ──(1:N)── ProductMapping

SettlementChecklist ──(1:1)── SalesCampaign
SettlementChecklist ──(1:N)── SettlementChecklistItem
```

## 관계 설명

- **Partner ↔ Deal**: Partner(거래처: 브랜드/벤더/대행사/에이전시)가 Deal(상품/딜)을 공급한다. `Deal.partnerId`는 Postgres 스키마에서 nullable(레거시 데이터 이관 여유), SQLite 스키마에서는 필수로 되어 있어 provider별 차이가 있다.
- **Partner ↔ Seller (대행)**: Partner가 `type=AGENCY`일 때 Seller의 `agencyId`로 소속을 나타낸다 ("SellerAgency" named relation).
- **Deal ↔ SalesCampaign**: 하나의 Deal은 여러 SalesCampaign(세일즈 캠페인, 이 시스템의 핵심 운영 단위)에서 판매될 수 있다. 캠페인은 Deal + Seller + 판매 기간/채널의 조합.
- **SalesCampaign ↔ CampaignDeal**: 캠페인 안에서 다수의 딜(옵션 포함)이 동시에 판매될 때 CampaignDeal이 캠페인별 실적(orderCount, actualSales, feeRate 등)을 딜 단위로 기록한다. `@@unique([campaignId, dealId])`.
- **SalesCampaign ↔ SettlementChecklist**: 캠페인 1건당 정산 체크리스트 1건(1:1, `campaignId @unique`). 체크리스트 항목(SettlementChecklistItem)은 정산 진행 단계(입금 확인, 세금계산서 발행 등)를 순서대로 관리한다.
- **Deal 자기참조(DealOptions)**: `dealType=MAIN`인 상위 딜에 `dealType=OPTION`인 하위 옵션 딜들이 `parentDealId`로 연결된다.
- **Partner 자기참조(PartnerReferral)**: 거래처 소개 관계(누가 누구를 소개했는지)를 `referredById`로 추적.

## Phase 1 신규 모델의 관계 (2026-07-06 추가)

- **ActionProposal**: AI 에이전트의 산출물(READ) 또는 실행 기안(WRITE)을 표현. `campaignId`로 특정 캠페인에 느슨하게 연결(nullable, SetNull) 가능하고, `targetEntityType/targetEntityId`로 임의 엔티티를 다형 참조한다(Asset/ActivityLog와 동일 패턴). 상태 변경마다 ActionProposalEvent가 1건씩 append되어 감사 추적이 가능하다.
- **WorkRecord**: 카카오톡/이메일/메모 등 외부 소통 기록의 원문(마스킹 후)과 요약을 저장. `entityType/entityId`(PARTNER/SELLER/CAMPAIGN)로 다형 귀속하며, 미귀속 상태(null)도 허용한다. `campaignId`는 별도 FK로 병행 제공.
- **ChatRoomMapping**: 카카오톡 방(roomKey)과 Partner/Seller 엔티티를 연결하는 매핑 테이블. 방 이름이 바뀌어도 roomKey는 유지되므로 별도 테이블로 분리했고, `lastSyncedAt`으로 증분 동기화 커서를 관리한다.
- **PriceSheet ↔ PriceSheetRow**: 파트너(밴더/브랜드)로부터 받은 가격표 원본 파일(이미지/엑셀/CSV/PPTX/PDF)을 PriceSheet로, 추출된 행 단위 데이터를 PriceSheetRow로 저장한다. PriceSheetRow는 `mappedDealId`로 기존 Deal에 매핑되거나 `mappingStatus=NEW_DEAL`로 신규 딜 후보가 된다. Partner ↔ PriceSheet는 nullable(파트너 미특정 상태로 먼저 업로드 가능).

## 관계 요약 표

| From | To | 관계 | FK 컬럼 | onDelete |
|---|---|---|---|---|
| Deal | Partner | N:1 | partnerId | (Postgres: 명시 없음, SQLite: Restrict) |
| Seller | Partner | N:1 ("SellerAgency") | agencyId | SetNull(SQLite) |
| SalesCampaign | Deal | N:1 | dealId | Restrict(SQLite) |
| SalesCampaign | Seller | N:1 | sellerId | Restrict(SQLite) |
| CampaignDeal | SalesCampaign | N:1 | campaignId | Cascade |
| CampaignDeal | Deal | N:1 | dealId | Restrict |
| SettlementChecklist | SalesCampaign | 1:1 | campaignId | Cascade |
| ActionProposal | SalesCampaign | N:1 (nullable) | campaignId | SetNull |
| WorkRecord | SalesCampaign | N:1 (nullable) | campaignId | SetNull |
| PriceSheet | Partner | N:1 (nullable) | partnerId | SetNull |
| PriceSheetRow | PriceSheet | N:1 | priceSheetId | Cascade |
| PriceSheetRow | Deal | N:1 (nullable) | mappedDealId | SetNull |
