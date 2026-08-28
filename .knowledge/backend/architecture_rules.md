---
type: concept
title: Backend Architecture Rules
description: Structural design, layer responsibilities, and external integrations for the backend API.
tags: [architecture, backend, api, Next.js]
timestamp: "2026-06-16T13:36:00+09:00"
---

# Backend Architecture Rules

## Target Architecture (Layered Approach)

To avoid Fat Controllers (API Routes), we follow a 3-layer progressive refactoring approach:

1. **Controllers (`src/app/api/**/route.ts`)**
   - Responsible *only* for: request parsing, authorization checks, and returning responses.
   - Keep controllers as thin as possible.

2. **Services (`src/services`)**
   - Encapsulates core and repetitive business logic (e.g., margin calculations, authorization business rules).

3. **Repositories (`src/repositories`)**
   - Exclusively handles database access via Prisma.
   - Isolates ORM dependencies from the rest of the application.

## API Structure

The API is structured around RESTful resources inside `src/app/api/`:
- `/partners`, `/sellers`, `/deals`, `/campaigns`, `/outreach`, `/settlement-checklist`
- `/activity-log`, `/notifications`, `/search`, `/reports/settlement`
- `/import` (CSV validation & execution)
- `/cron` (Vercel Cron triggers for Instagram/YouTube data collection and notifications)
- `/auth/signout`

## External Integrations

| Service | Purpose | Auth Method |
|--------|------|----------|
| **Supabase** | DB + Auth | Connection string (`DATABASE_URL`, `DIRECT_URL`) |
| **Instagram Graph API** | Follower count collection | App Token |
| **YouTube Data API v3** | Subscriber count collection | API Key |
| **Google Drive** | Asset storage | OAuth 2.0 (tokens stored in `StorageIntegration` DB table) |
| **Vercel Cron** | Scheduled execution | Bearer Token (`CRON_SECRET`) |

## Cron Jobs (vercel.json)

- `/api/cron/collect-instagram`: Weekly (Mon 03:00 UTC)
- `/api/cron/collect-youtube`: Weekly (Mon 03:00 UTC)
- `/api/cron/notifications`: Daily (09:00 UTC) - notifications for settlement overruns, deadlines, non-responses.

## Order Converter (Excel Generator)

The Order Converter module (`src/lib/order-converter`) maps API/user provided order data into Excel templates.
- **Templates**: Stored in `public/{templateId}_template.xlsx`.
- **Column Mappings**: For `nutrione_template`, specific columns map to specific logic. Make sure not to overwrite the template's formulas unnecessarily. If columns shift in the vendor's template, adjust the mapping indices in `excel-generator.ts` (e.g. product code, verification status, sale price mapped to cols 16, 17, 18).
