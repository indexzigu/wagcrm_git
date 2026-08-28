# WAG CRM

Next-Gen 커머스 중개 & 세일즈 트래킹 CRM MVP.

## Stack

- Next.js App Router, TypeScript, Tailwind CSS
- shadcn/ui, Tremor, TanStack Table, TanStack Virtual
- Prisma schema + local SQLite dev database
- Redis/BullMQ worker architecture with mock queue mode by default
- Supabase/Google Drive-ready asset metadata and storage provider abstraction

## Local Run

```bash
npm install
npm run db:generate
npm run db:push
npm run db:seed:local
npm run dev:local
```

Open `http://localhost:3002`.

⚠️ 개발 서버는 **3002** 다. 이 맥은 2026-08-13 부터 프로덕션 호스트라 **3000 은 프로덕션**
(`crm.ygrd.kr`), **3001 은 프리뷰**(`crm-test.ygrd.kr`)가 쓴다. 개발용이 그 포트를 잡으면
서비스를 죽이거나, 죽이지 않더라도 "localhost:3000 을 열었는데 사실 프로덕션이었다"가
된다. 포트 정합은 `scripts/__tests__/dev-lane-ports.test.ts` 가 고정한다.

`db:seed:local` · `dev:local` 은 로컬 sqlite(`prisma/dev.db`)를 쓴다. 시드는
실행 시점 기준 상대 날짜로 최근 6개월 캠페인과 매출 목표(연 1건 + 월 12건)를
만들므로, 대시보드의 추이 차트와 "목표 대비 달성"이 언제 돌려도 채워진다.

> ⚠️ `npm run dev`(= 오버라이드 없음)는 `.env` 의 `DATABASE_URL`, 즉 **프로덕션
> Supabase** 에 붙는다. 시드는 이를 막기 위해 `DATABASE_URL=file:...` 이 아니면
> 중단한다.

## Checks

```bash
npm run env:check
npm run verify:cache-policy
npm run verify:release-config
npm run verify:github-secrets
npm run verify:vercel-auth
npm run release:check
npx prisma validate
npm run qa:smoke
npm run test
npm run lint
npm run build
```

## Notes

- `.env` defaults to mock mode, so external Instagram/YouTube API keys are not required.
- Asset management uses Supabase Storage for small working files and Google Drive for long-term materials.
- Google Drive upload requires `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and `ASSET_TOKEN_ENCRYPTION_KEY`; Drive links can be registered without OAuth.
- Supabase Storage env is optional in local development. Without `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) and a key, uploads create metadata with the intended storage path only.
- `npm run qa:smoke` targets `http://localhost:3000` by default; override with `WAG_CRM_BASE_URL` if the dev server is running elsewhere. ⚠️ 이 맥에서는 그 기본값이 **프로덕션**을 가리킨다(개발 서버는 3002) — 개발본을 재려면 `WAG_CRM_BASE_URL` 을 반드시 준다.
- `npm run env:check` validates the env shape expected by the current app and release checklist before deeper QA runs.
- `npm run verify:cache-policy` checks cached surfaces, dynamic exceptions, and whether write APIs still call the expected invalidation helpers.
- `npm run verify:release-config` checks that the GitHub Actions preflight secrets, release checklist, and local env validation stay in sync.
- `npm run verify:github-secrets` audits the current GitHub repository secret set against the release preflight requirement list.
- `npm run verify:vercel-auth` blocks deploy unless Vercel CLI is logged in as `indexzigu` and can access `indexzigus-projects`.
- `npm run release:check` bundles serverless preflight checks: env validation, cache policy verification, lint, and production build.
- `npm run qa:smoke` conditionally verifies Drive integration status only when the relevant OAuth env is configured; otherwise the rest of the smoke flow still runs.
- `./deploy.command` now blocks deployment unless `npm run release:check` succeeds first.
- `.github/workflows/release-preflight.yml` runs the same `release:check` sequence on `main` pushes and manual dispatch using repository secrets.
- Release handoff and manual production checks are captured in `RELEASE_CHECKLIST.md`.
- Daily production DB backup is handled by GitHub Actions; see `BACKUP_RUNBOOK.md`.
- One-off import verification is available via `npm run verify:import-health`.
