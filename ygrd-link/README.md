# ygrd-link

공구 유입추적 리다이렉터. `https://go.ygrd.kr/{code}` 로 들어온 클릭을 기록한 뒤
브랜드사 원본 링크로 302 시킨다.

wag-crm(Vercel)은 이 경로에 관여하지 않는다 — 링크 발급(쓰기)과 통계 조회(읽기)만
한다. 캠페인 트래픽이 아무리 몰려도 CRM 함수 호출은 0건이다.

## 구조

```
클릭 → Cloudflare Worker → 302 → 브랜드사 스마트스토어
                └ (응답 후) LinkClick 적재 → Supabase
```

- 목적지 조회는 Cache API 로 5분 캐시 → 대부분의 클릭은 DB 왕복 0회
- 로그 적재는 `ctx.waitUntil()` → 리다이렉트 지연 0ms
- 조회 실패·미등록 코드·만료 링크는 전부 `FALLBACK_URL` 로 흡수 (셀러 링크가 죽지 않게)

## 선행 조건 — 테이블

`TrackedLink`·`LinkClick` 은 wag-crm 쪽 마이그레이션
`prisma/migrations/20260731150000_add_tracked_link` 이 만든다. 그 마이그레이션이
**RLS 까지 같이 켜므로**(레포 규약 "New Table ⇒ New RLS") Supabase SQL Editor 에서
따로 실행할 것은 없다 — anon key 로는 `/rest/v1/LinkClick` 이 비어 나와야 정상이고,
이 Worker 는 `service_role` 이라 우회한다.

배포 순서는 **wag-crm 배포(`infra/selfhost/deploy.sh` 가 마이그레이션을 적용) → Worker
배포**다. 뒤집으면 Worker 가 아직 없는 테이블·컬럼을 건드려 조회가 실패한다.
⛔ 종전 서술의 "승격"은 **SUPERSEDED** — 2026-08-13 자체호스팅 컷오버 이후 `release`
승격은 구 플랫폼 롤백 창구 전용이고, 프로덕션 반영은 `deploy.sh` 가 한다(P6
`docs/agents/deployment.md`).

## 배포

```bash
npm install
npx wrangler login

npx wrangler secret put SUPABASE_URL               # https://sb.ygrd.kr (자체호스팅)
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # infra/selfhost/.env 의 SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put HASH_SALT                  # 랜덤 32자 — 한 번 정하면 절대 변경 금지

npx wrangler deploy
```

⚠️ **`wrangler deploy` 는 실행한 체크아웃의 소스를 올린다.** 반드시 `main` 을 추종하는
운영 체크아웃(`~/selfhost/wagcrm/ygrd-link`)에서 실행할 것 — 개발 레포
(`~/Projects/wag-crm`)는 다른 브랜치에 머물러 있을 수 있고, 실제로 2026-08-14 에
낡은 소스가 한 번 배포됐다(재배포로 복구).

시크릿만 바꿀 때는 `wrangler deploy` 가 필요 없다 — `secret put` 은 배포된 Worker 에
즉시 적용된다.

`HASH_SALT` 를 바꾸면 그 이후 방문자가 전부 새 사람으로 잡혀 순방문자 수가 깨진다.

### ⚠️ 자체호스팅 이관(2026-08-13) 때 이 레인이 통째로 누락됐다

CRM 의 DB 가 클라우드 Supabase → 자체호스팅(`sb.ygrd.kr`)으로 옮겨졌는데 **이 Worker 의
시크릿은 구 클라우드를 계속 가리켰다.** 그래서 컷오버 이후 발급된 링크는 Worker 눈에
존재하지 않았고(`302 → FALLBACK_URL`), 클릭 적재는 2026-08-12 를 끝으로 멈춰 있었다.
증상이 "링크가 안 열린다" 하나뿐이라 8월 14일 오너가 실제로 링크를 만들어 볼 때까지
아무도 몰랐다.

시크릿을 재조준한 뒤에도 PostgREST 가 **403 `permission denied for table TrackedLink`**
를 돌려줬다 — 이관이 데이터는 옮겼지만 **Supabase 역할 권한을 재적용하지 않아**
`service_role` 에 `public` 스키마의 어느 테이블 권한도 없었다. CRM 은 PostgREST 가 아니라
`DATABASE_URL` 로 DB 에 직접 붙기 때문에 멀쩡해 보였다.

조치(적용 완료):

```bash
docker exec supabase-db psql -U postgres -d postgres -c 'GRANT SELECT ON public."TrackedLink" TO service_role; GRANT INSERT ON public."LinkClick" TO service_role;'
```

**최소 권한만 준다** — 이 Worker 는 링크를 읽고 클릭을 쓸 뿐이다. 스키마 전체에 부여하면
그 키 하나로 셀러 실명·주민등록번호 테이블까지 PostgREST 로 열린다(P0 셀러 데이터 노출면).
`service_role` 은 `BYPASSRLS=t` 라 RLS 는 걸림돌이 아니고 권한만 있으면 된다.

🪤 **앞으로 Prisma 가 만드는 새 테이블도 같은 상태로 태어난다** — 이 Worker 가 새 테이블을
읽어야 하면 그때마다 위 `GRANT` 를 함께 해야 한다. 컬럼 추가는 테이블 단위 권한이라
추가 조치가 필요 없다.

## 로컬 개발

`.dev.vars` 파일에 시크릿을 넣고 `npm run dev`. 이 파일은 커밋하지 않는다.

```
SUPABASE_URL="https://sb.ygrd.kr"
SUPABASE_SERVICE_ROLE_KEY="..."
HASH_SALT="..."
FALLBACK_URL="https://ygrd.kr"
```

## 확인

```bash
curl -I https://go.ygrd.kr/healthz          # 200
curl -I https://go.ygrd.kr/notarealcode     # 302 → FALLBACK_URL
npx wrangler tail                            # 실시간 로그
npm run typecheck
```

## 수집 항목

원문 IP·쿠키는 저장하지 않는다. 방문자 식별은 `sha256(HASH_SALT + IP + UA + KST일자)`
앞 16바이트만 남겨, 같은 날 같은 사람의 재클릭만 판별되고 개인 역추적은 불가능하다.

기기(mobile/tablet/desktop), OS, 브라우저, 유입 채널, referer 호스트, 국가·도시,
봇 여부(카톡·메타 링크 미리보기 크롤러 분리)를 남긴다.

## 주의

- 발급된 코드는 재발급하지 않는다. 목적지가 바뀌면 `TrackedLink.targetUrl` 만 수정
  (엣지 캐시 때문에 최대 5분 지연).
- 무료 플랜 한도는 하루 10만 요청. 초과 시 Cloudflare 가 `Error 1027` 을 낸다.
- `LinkClick.id` 는 이 Worker 가 만들어 보낸다 — Prisma 의 `@default(cuid())` 는
  앱 레벨 기본값이라 DB 에 default 가 없다.
