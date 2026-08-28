# WAG CRM 서비스 아키텍처

> 최종 업데이트: 2026-05-15

## 서비스 구성 요약

| 레이어 | 서비스 | 역할 | 상태 |
|--------|--------|------|------|
| 프론트엔드 | Next.js (App Router) | React UI + Server Components | ✅ 운영 |
| 백엔드 API | Next.js API Routes | REST API (src/app/api/) | ✅ 운영 |
| 데이터베이스 | Supabase PostgreSQL (셀프호스트 스택) | 데이터 영속화 (Prisma ORM) | ✅ 설정 완료 |
| 인증 | Supabase Auth (셀프호스트 GoTrue) | 이메일/OAuth 로그인 + RBAC | ✅ 구현 완료 |
| 파일 저장소 | Google Drive | 캠페인 에셋 업로드 | ✅ 코드 완료 (크레덴셜 필요) |
| 호스팅 | Vercel | 앱 배포 + Serverless Functions | 📋 배포 대기 |
| 크론잡 | Vercel Cron | Instagram/YouTube 수집, 알림 생성 | 📋 배포 대기 |
| CDN | Vercel Edge Network | 정적 자산 + 글로벌 배포 | 📋 배포 대기 |

> ⚠️ **2026-08-13 셀프호스트 컷오버** — DB·인증은 클라우드 Supabase 프로젝트가 아니라
> 오너 iMac 에서 도는 **셀프호스트 Supabase 스택**(`supabase-db` 컨테이너 + supavisor
> 풀러)이다. 제품은 그대로 Supabase 이고 바뀐 것은 **어디서 도는가**다. 운영 좌표 정본은
> `infra/selfhost/README.md`.
> ⚠️ 위 표의 **호스팅·크론잡·CDN 행(Vercel)은 갱신되지 않았다** — 이 문서는 서비스 상태표가
> 낡은 것으로 등재돼 있다(`docs/agents/codebase-map.md` 문서 지도). 배포 레인의 정본은
> `docs/agents/deployment.md`(P6)다.

---

## 점진적 구조 개편 정책 (Opportunistic Refactoring Policy)

> **ROI 기반 아키텍처 가이드라인**에 따라, 무리한 전면 재작성(Big Bang Refactoring)을 지양하고 **기능 수정이나 추가 작업 시** 관련된 영역만 점진적으로 분리하는 정책을 따릅니다.

### 프론트엔드 목표 구조 (UI & 상태 분리)
- **`src/components/common`**: 여러 페이지에서 범용적으로 쓰이는 순수 UI 컴포넌트 분리 (Rule of Three 적용)
- **`src/hooks`**: 컴포넌트 내부에 하드코딩된 API 호출(데이터 패칭) 및 비즈니스 상태 관리 로직 분리
- **`src/utils`**: 순수 도우미 함수 분리

### 백엔드 목표 구조 (계층형 아키텍처)
기존의 Fat Controller(API Route)를 3계층으로 점진적 분리합니다.
- **`src/app/api/**/route.ts` (Controllers)**: 클라이언트 요청 파싱, 권한 검증, 응답 반환만 담당 (최대한 얇게 유지)
- **`src/services`**: 마진 계산, 권한 확인 등 핵심적이고 반복적인 비즈니스 로직 캡슐화
- **`src/repositories`**: 데이터베이스(Prisma) 접근 로직만 전담하여 ORM 의존성 격리

*AI Agent 지침: 신규 기능 개발 또는 기존 코드 수정 시, 이 목표 구조에 맞춰 기회주의적으로 로직을 분리하세요.*

---

## 프론트엔드 구조

```
src/app/                    # Next.js App Router 페이지
├── page.tsx               # 대시보드 (/)
├── pipeline/page.tsx      # 세일즈 파이프라인
├── partners/page.tsx      # 파트너/셀러 관리
├── deals/page.tsx         # 딜/상품 관리
├── assets/page.tsx        # 에셋 관리
├── calendar/page.tsx      # 캘린더 뷰
├── reports/settlement/    # 정산 리포트
├── login/page.tsx         # 로그인
└── admin/                 # 관리자 설정

src/components/crm/        # CRM 전용 컴포넌트 (40+ 파일)
├── crm-shell.tsx          # 레이아웃 쉘 (사이드바 + 헤더)
├── global-search.tsx      # 통합 검색
├── notification-center.tsx # 알림 센터
├── *-grid.tsx             # 데이터 그리드 (Partners, Sellers, Deals)
├── *-panel.tsx            # 사이드 피크 패널
├── calendar-view.tsx      # 캘린더 컴포넌트
├── settlement-checklist.tsx # 정산 체크리스트
└── csv-import-dialog.tsx  # CSV 임포트

src/components/ui/         # shadcn/ui 기본 컴포넌트
```

---

## 백엔드 API 구조

```
src/app/api/
├── partners/              # 거래처 CRUD
│   ├── route.ts          # GET (list + filter), POST (create)
│   └── [id]/route.ts    # PATCH (update), DELETE (delete)
├── sellers/               # 셀러 CRUD
│   ├── route.ts
│   └── [id]/
│       ├── route.ts
│       └── history/route.ts  # 팔로워 히스토리
├── deals/                 # 딜 CRUD + 수익성 분석
│   ├── route.ts
│   ├── [id]/route.ts
│   └── profitability/route.ts
├── campaigns/             # 캠페인 관리
│   ├── route.ts          # GET (list + filter), POST (create)
│   ├── [id]/route.ts    # PATCH, DELETE
│   ├── duplicate/route.ts # 캠페인 복제
│   ├── bulk/route.ts     # 벌크 생성
│   ├── templates/        # 템플릿 CRUD
│   └── calendar/route.ts # 캘린더 데이터
├── outreach/              # 셀러 제안 관리
│   ├── route.ts
│   └── [id]/route.ts
├── settlement-checklist/  # 정산 체크리스트
│   ├── route.ts
│   └── [id]/
│       ├── route.ts      # 항목 토글
│       └── items/route.ts # 커스텀 항목 추가
├── activity-log/route.ts  # 활동 로그
├── notifications/         # 알림 CRUD
│   ├── route.ts
│   └── [id]/route.ts
├── search/route.ts        # 글로벌 검색
├── reports/settlement/route.ts # 정산 리포트
├── import/                # CSV 임포트
│   ├── validate/route.ts
│   └── execute/route.ts
├── cron/                  # 크론잡 (Vercel Cron 트리거)
│   ├── collect-instagram/route.ts
│   ├── collect-youtube/route.ts
│   └── notifications/route.ts
└── auth/                  # 인증
    └── signout/route.ts
```

---

## 데이터베이스 (Prisma 모델)

| 모델 | 역할 |
|------|------|
| Partner | 거래처 (브랜드/벤더/대행사/에이전시) |
| Seller | 셀러 (인플루언서/크리에이터) |
| SellersHistory | 팔로워 수 시계열 스냅샷 |
| Deal | 상품/딜 (소싱→확정 파이프라인) |
| SalesCampaign | 세일즈 캠페인 (핵심 운영 단위) |
| CampaignActivity | 캠페인 활동 로그 |
| CampaignNote | 캠페인 노트 |
| CampaignTemplate | 캠페인 템플릿 |
| SellerOutreach | 셀러 제안 관리 |
| SettlementChecklist | 정산 체크리스트 |
| SettlementChecklistItem | 정산 체크리스트 항목 |
| ActivityLog | 범용 활동 로그 (모든 엔티티) |
| Notification | 알림 |
| Asset | 에셋 파일 메타데이터 |
| StorageIntegration | 외부 저장소 연동 (Google Drive) |
| ApiCallLog | 외부 API 호출 로그 |
| TrackingAttribution | 트래킹 어트리뷰션 |

---

## 외부 서비스 연동

| 서비스 | 용도 | 인증 방식 | 환경변수 |
|--------|------|----------|----------|
| Supabase (셀프호스트 스택) | DB + Auth | Connection string | DATABASE_URL, DIRECT_URL |
| Instagram Graph API | 팔로워 수집 | App Token | INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID |
| YouTube Data API v3 | 구독자 수집 | API Key | YOUTUBE_API_KEY |
| Google Drive | 에셋 저장 | OAuth 2.0 | StorageIntegration 테이블에 토큰 저장 |
| Vercel Cron | 스케줄 실행 | Bearer Token | CRON_SECRET |

---

## 배포 환경

### 환경변수 목록 (.env.example 참조)

```
# Database
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...

# Auth (셀프호스트 Supabase — 클라우드 프로젝트 주소가 아니다)
NEXT_PUBLIC_SUPABASE_URL=https://sb.ygrd.kr
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Instagram
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_BUSINESS_ACCOUNT_ID=

# YouTube
YOUTUBE_API_KEY=

# Cron
CRON_SECRET=

# Google Drive (OAuth tokens stored in DB)
```

### Vercel Cron 스케줄 (vercel.json)

| 경로 | 스케줄 | 설명 |
|------|--------|------|
| /api/cron/collect-instagram | 매주 월요일 03:00 UTC | Instagram 팔로워 수집 |
| /api/cron/collect-youtube | 매주 월요일 03:00 UTC | YouTube 구독자 수집 |
| /api/cron/notifications | 매일 09:00 UTC | 알림 생성 (정산 초과, 마감 임박, 미응답) |

---

## 기술 스택 요약

- **Runtime**: Node.js 20+
- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict)
- **UI**: React 19 + shadcn/ui + Tailwind CSS 4
- **Charts**: Recharts
- **ORM**: Prisma 6
- **DB**: PostgreSQL (셀프호스트 Supabase)
- **Auth**: Supabase Auth (셀프호스트 GoTrue)
- **Validation**: Zod
- **CSV**: papaparse
- **Testing**: Vitest + fast-check (PBT)
- **Hosting**: Vercel
- **CI/CD**: Git push → Vercel 자동 배포
