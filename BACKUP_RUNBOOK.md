# 데이터베이스 백업 런북

## 목적

운영(프로덕션) Postgres 데이터베이스를 하루 1회 오프사이트(외부 저장소) 논리 백업으로 보관한다.

이 저장소는 Vercel cron 대신 GitHub Actions 스케줄 워크플로를 사용한다.
이유는 워크플로 러너에서 Supabase CLI를 안정적으로 설치/실행할 수 있고, Vercel 서버리스 함수는 `pg_dump` 계열 작업(덤프/압축/업로드)을 수행하기에 적합하지 않기 때문이다.

## 백업 경로

- Workflow: [.github/workflows/daily-db-backup.yml](.github/workflows/daily-db-backup.yml)
- Schedule: 매일 `18:00 UTC` (`03:00 KST`)
- 산출물 파일:
  - `roles.sql`
  - `schema.sql`
  - `data.sql`
  - `manifest.txt`
- 저장 위치: GitHub Actions 워크플로 아티팩트(artifact)
- 보관 기간: `30`일

## 필요한 GitHub Secret

- `SUPABASE_DB_BACKUP_URL`

백업 전용으로 사용할 운영 Postgres 접속 문자열을 설정한다.
개발자 로컬에서 쓰는 접속 문자열을 재사용하지 말고, 백업 워크플로용으로 별도 DB 비밀번호/계정을 사용하는 것을 권장한다.

## 워크플로가 하는 일

1. 최신 Supabase CLI를 설치한다.
2. 역할(roles), 스키마(schema), 데이터(data)를 분리해서 덤프한다.
3. 생성 시각, run id, commit sha, SHA-256 해시가 포함된 `manifest.txt`를 기록한다.
4. 백업 디렉터리를 워크플로 아티팩트로 업로드한다.

## 복구 리허설(드릴)

워크플로를 활성화한 직후 최소 1회, 이후 주기적으로 수행한다.

1. GitHub Actions에서 백업 아티팩트 1개를 다운로드한다.
2. 임시(Postgres) 데이터베이스에 복구한다.
3. 핵심 테이블이 정상 조회되는지 확인한다:
   - `Partner`
   - `Seller`
   - `Deal`
   - `SalesCampaign`
   - `ImportBatch`
4. row count가 상식적인 수준인지, 최근 캠페인이 최소 1개 이상 존재하는지 확인한다.

## Import 반영 점검

CSV import는 일회성 수단이므로 자동화 고도화는 우선순위가 낮지만, import 이후 반영 상태 점검은 유용하다.

실행:

```bash
npm run verify:import-health
```

출력 내용:

- 최근 import batch 목록
- 최신 Google Sheets batch의 action 카운트(create/update/review)
- 최근 create/update 대상 샘플
- `month + seller + deal + round` 기준 중복 캠페인 그룹 여부
