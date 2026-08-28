# WAG CRM Release Checklist

Use this before promoting a build or handing the repo to another operator.

## 1. Environment

- [x] `DATABASE_URL` and `DIRECT_URL` point to the intended Supabase Postgres project.
- [x] `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are populated for the same project.
- [x] `SUPABASE_ASSET_BUCKET` is set if production should use a bucket name other than `crm-assets`.
- [ ] `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and `ASSET_TOKEN_ENCRYPTION_KEY` are set if Drive upload is required.
- [x] `NEXT_PUBLIC_APP_URL` matches the real deploy origin used by Google OAuth callback.

## 2. Static Validation

Run from repo root:

```bash
npm run release:check
```

This bundles:

```bash
npm run env:check
npm run verify:cache-policy
npm run verify:release-config
npm run lint
npm run build
```

Expected result:

- `release:check` exits `0`
- `env:check` exits `0`
- `verify:cache-policy` exits `0`
- `verify:release-config` exits `0`
- `lint` exits `0`
- `build` exits `0`
- `deploy.command` also runs this preflight automatically before `vercel deploy --prod`
- `.github/workflows/release-preflight.yml` runs the same preflight in GitHub Actions for `main` pushes and manual dispatch

Repository secrets required by the GitHub Actions preflight:

- `DATABASE_URL`
- `DIRECT_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `ENCRYPTION_KEY` — 셀러 주민등록번호 암·복호화. 폴백 기본 키가 없으므로(2026-07-23)
  비어 있으면 런타임이 던진다. 프리렌더가 실 DB를 읽으며 복호화하므로 CI에도 필요하다.

Optional but recognized by the CI audit:

- `SUPABASE_ASSET_BUCKET`
- `NEXT_PUBLIC_SITE_URL`
- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REDIRECT_URI`
- `GOOGLE_DRIVE_ROOT_FOLDER_ID`
- `ASSET_TOKEN_ENCRYPTION_KEY`
- `ENCRYPTION_KEY_PREVIOUS` — 암호화 키 교체 **전환 기간에만** 설정한다. 재암호화
  (`scripts/reencrypt-resident-numbers.ts --apply`) 완료 후 제거할 것. 절차는 P6 런북.

Remote audit command:

```bash
npm run verify:github-secrets
```

## 3. Local Smoke Validation

Run with the local app available at `WAG_CRM_BASE_URL` or `http://localhost:3000`:

```bash
npm run qa:smoke
```

Expected result:

- `qa:smoke` exits `0`
- If Google Drive OAuth env is configured, the Drive status sub-check returns `CONNECTED` or `DISCONNECTED` rather than `ERROR`

## 4. Verified Automated Coverage

These are already covered by `npm run qa:smoke` or API-level checks completed in this repo:

- Asset link create/delete path
- Conversion attribution create/cleanup path
- Google Drive integration status refresh path
- Asset and conversion cleanup count restoration

These were also verified in prior browser/API QA and should not need re-debugging unless code changed:

- Campaign create/edit/delete
- Partner/Seller/Deal CRUD
- Campaign note create/delete
- Asset upload/delete on `/assets`
- Campaign side-panel asset upload

## 5. Required Manual Production Checks

These still require a real human session:

### Google OAuth

- [ ] Click `Drive 연결` from `/assets`
- [ ] Complete Google consent
- [ ] Confirm callback returns to app with `?drive=connected`
- [ ] Confirm `storageIntegration(provider=GOOGLE_DRIVE)` becomes `CONNECTED`
- [ ] Confirm account email and root folder id are stored

### Real Drive Upload

- [ ] Upload a file that should route to Google Drive
- [ ] Confirm asset row is created
- [ ] Confirm file is visible in the expected Drive folder
- [ ] Confirm download/open action resolves correctly
- [ ] Clean up the test file or archive it intentionally

### Real Supabase Storage Upload

- [x] Run automated connection check: `npm run verify:supabase-storage`
- [x] Confirm script exits with 0 and prints "Supabase Storage Verification PASSED"

### Auth

- [ ] Confirm production login works without the dev bypass route
- [ ] Confirm protected routes redirect unauthenticated users to `/login`
- [ ] Confirm authenticated users can open `/`, `/partners`, `/deals`, `/assets`

## 6. Post-Deploy Smoke

- [ ] Open `/`
- [ ] Open one campaign side panel
- [ ] Save actual sales once and confirm no server error
- [ ] Open `/assets` and confirm existing rows render
- [ ] Open `/partners` and `/deals` and confirm tables render
- [ ] Check browser console for new runtime errors

## 7. Known Non-Blocking Constraints

- The campaign side-panel `전환 테스트 기록` button is verified through DOM-triggered browser automation because the scroll container can block default Playwright viewport clicking. The API path itself is verified.
- Side-panel asset archive was verified through API cleanup after UI upload confirmation; the upload path is the higher-risk part and is covered.
- Google Drive end-to-end upload remains pending real OAuth consent.
## 2026-05-16 Notion Import Release QA

- [x] `npm run env:check`
  - Warning only: `NEXT_PUBLIC_SITE_URL` is not set.
- [x] `npm run qa:smoke`
  - Passed after updating `scripts/smoke-crm.ts` to select a live campaign id from the database instead of the removed seed id `camp-glow-mina`.
- [x] `npm run lint`
  - Passed with warnings only (`0 errors, 7 warnings`).
- [x] `npm run build`
- [x] Remote Supabase schema synced before import apply
- [x] Remote Notion import dry-run/apply artifacts recorded in `artifacts/`
- [x] Review backlog triage
    - Seller review 3 (Completed: pending=0, blocked=0)
    - Deal review 19 (Completed: pending=0, blocked=0)
    - Campaign review 10 (Completed: pending=0, blocked=0)
