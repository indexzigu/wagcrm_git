# WAG CRM 보안 및 백업 관리 매뉴얼

이 문서는 WAG CRM 프로젝트의 보안 설정(인증 정보, 민감 데이터)과 백업/장애 추적 시스템이 어떻게 동작하는지 설명하는 시스템 운영 지침(Runbook)입니다. 에이전트와 개발자는 보안 점검이나 장애 조치 시 이 매뉴얼을 기준으로 행동해야 합니다.

## 1. 보안 관리 시스템 (Security Management)

### 1.1. 자격 증명(Credentials) 관리 원칙
- **소스코드 하드코딩 엄격 금지:** `DATABASE_URL`, API Key 등 모든 민감 정보는 소스코드(`.ts`, `.js`, `.py` 등)에 하드코딩해서는 안 됩니다.
- **로컬 개발 환경:** 모든 비밀번호와 키는 `.env` 파일에 기록하며, `.env`는 `.gitignore`에 포함되어 저장소에 올라가지 않도록 격리됩니다.
- **운영 배포 환경:** Vercel 환경 변수나 보안 Secret Manager(예: 1Password, GCP Secret Manager)를 통해 주입됩니다.
- **더미 파일 유지:** 깃허브에는 템플릿 형태의 `.env.example`만 업로드하여 로컬 셋업을 돕습니다.

### 1.2. 보안 유출 의심 시 행동 지침 (Incident Response)
만약 `.env` 파일이 실수로 커밋되거나, 로그 파일 등을 통해 DB 비밀번호나 민감 키가 유출된 정황이 발견될 경우 다음 절차를 따릅니다.
1. **즉각적인 키 무효화 (Rotation):** Supabase 대시보드 또는 서비스 제공자 콘솔에서 해당 키와 비밀번호를 즉시 재생성합니다.
2. **Git 히스토리 정리 (선택):** 유출된 평문이 Git 커밋에 포함되었다면 `git filter-repo` 등을 사용해 히스토리를 정리합니다.
3. **환경 변수 업데이트:** 교체된 신규 키를 운영 환경(Vercel)과 개발자 로컬(`.env`)에 일괄 배포합니다.
4. **절대 금지 사항:** 로컬 `.env` 파일을 복원한답시고 채팅창, PR 본문, 이슈 문서에 평문을 그대로 복사/붙여넣기 하지 마세요.

---

## 2. 상태 복원 및 백업 시스템 (Backup Management)

### 2.1. 자동 백업 워크플로 (GitHub Actions)
- **실행 위치:** `.github/workflows/daily-db-backup.yml`
- **실행 주기:** 매일 UTC 기준 지정 시간
- **작동 방식:** 
  - `SUPABASE_DB_BACKUP_URL` 환경 변수를 이용해 Supabase CLI로 운영 DB에 접근합니다.
  - Role, Schema, Data를 분리하여 SQL 파일로 추출합니다.
  - **매니페스트 기록:** 어느 프로젝트에서 덤프되었는지 식별할 수 있도록, DB URL에서 Supabase 프로젝트 ID(`supabase_project_id`)를 파싱하여 `manifest.txt`에 명시적으로 기록합니다.
  - 백업 산출물은 GitHub Artifacts에 30일간 안전하게 보관됩니다.

### 2.2. 복구 및 상태 복원 절차
데이터 유실이 발생하거나 과거 상태로 롤백해야 할 경우 다음을 수행합니다.
1. **아티팩트 식별:** GitHub Actions에서 `db-backup-[run_id]` 아티팩트를 다운로드하고 `manifest.txt`를 열어 `supabase_project_id`가 복구하려는 타겟 DB 인스턴스와 일치하는지 검증합니다.
2. **덤프 복원:** Supabase CLI 또는 `psql`을 사용하여 임시 환경이나 타겟 DB에 `roles.sql` -> `schema.sql` -> `data.sql` 순으로 복원합니다.

---

## 3. 장애 추적 시스템 (Fault Tracking)

### 3.1. Sentry 연동 및 태깅
- **동작 방식:** `sentry.server.config.ts` 및 `sentry.edge.config.ts`를 통해 서버사이드 에러를 Sentry로 자동 전송합니다.
- **프로젝트 식별자 강화 (supabase_project):** 여러 Supabase 프로젝트(Dev, Staging, Prod)를 운영할 때 에러가 섞이는 것을 방지하기 위해, Sentry 설정 파일에서 `NEXT_PUBLIC_SUPABASE_URL`을 파싱하여 **`supabase_project`** 태그를 모든 에러 이벤트에 자동으로 부착합니다.
- **디버깅 지침:** 
  - 에러나 장애 발생 시 Sentry 대시보드에서 `tags.supabase_project` 값을 기준으로 필터링하여 특정 인스턴스에서 발생한 문제인지 격리하여 분석합니다.
  - 프로젝트 ID(`cefnwaasfepmbjokzzvz` 등) 자체는 보안 유출 위험도가 낮고 디버깅에 큰 도움을 주므로, 에러 로그나 디버깅 기록에서 이를 강제로 마스킹(삭제)하지 않고 식별자로 적극 활용합니다.
