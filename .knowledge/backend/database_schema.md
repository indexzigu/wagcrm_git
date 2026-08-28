---
type: concept
title: Database Schema (Prisma Models)
description: Overview of the wag-crm database schema and core entities.
tags: [database, schema, prisma, backend]
timestamp: "2026-06-16T13:36:00+09:00"
---

# Database Schema

The database for wag-crm is a Supabase PostgreSQL instance, managed via Prisma ORM.

## Core Models

| Model | Role |
|------|------|
| **Partner** | 거래처 (브랜드/벤더/대행사/에이전시) |
| **Seller** | 셀러 (인플루언서/크리에이터) |
| **SellersHistory** | 팔로워 수 시계열 스냅샷 |
| **Deal** | 상품/딜 (소싱→확정 파이프라인) |
| **SalesCampaign** | 세일즈 캠페인 (핵심 운영 단위) |
| **CampaignActivity** | 캠페인 활동 로그 |
| **CampaignNote** | 캠페인 노트 |
| **CampaignTemplate** | 캠페인 템플릿 |
| **SellerOutreach** | 셀러 제안 관리 |
| **SettlementChecklist** | 정산 체크리스트 |
| **SettlementChecklistItem** | 정산 체크리스트 항목 |
| **ActivityLog** | 범용 활동 로그 (모든 엔티티) |
| **Notification** | 알림 |
| **Asset** | 에셋 파일 메타데이터 |
| **StorageIntegration** | 외부 저장소 연동 (Google Drive) |
| **ApiCallLog** | 외부 API 호출 로그 |
| **TrackingAttribution** | 트래킹 어트리뷰션 |

For exact field definitions and relationships, refer to the source of truth: `prisma/schema.prisma`.
