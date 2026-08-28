# Dev Environment & QA — P9 (AGENTS.md 라우터 모듈)

> `AGENTS.md`의 Mandatory Reading Router가 지정하는 조건부 필독 모듈이다.
> dev 서버 기동, QA, 테스트 작성·수정 전에 **전문**을 읽는다.
> 완료의 정의(DoD)는 `AGENTS.md` 코어에 있다 — 여기 규칙은 그 실행 환경이다.

- **Dev Servers:** `npm run dev` = **프로덕션 DB** 연결(셀프호스트 Supabase 스택
  `127.0.0.1:55432`, P0 주의).
  `npm run dev:ro` = 같은 프로덕션 DB인데 **쓰기 차단**(바로 아래 항목).
  `npm run dev:local` = sqlite `dev.db`(+webpack, 데이터 빈약 —
  `npm run db:seed:local`로 시딩). order-converter 등 postgres 전용 경로는
  dev:local에서 동작하지 않는다 — 이 경우 QA는 prod DB에 합성 데이터
  주입 → 검증 → 즉시 삭제로 한다. 로그인 우회는 `DEV_AUTH_BYPASS`
  (dev QA 전용).

- **🪤 프로덕션 DB 는 호스트 포트가 열려 있어야 셸에서 닿는다(2026-08-25 컷오버 여파):**
  `.env` 의 `DATABASE_URL` 은 `127.0.0.1:55432` 를 가리키는데, 셀프호스트 supabase 스택의
  upstream `docker-compose.yml` 은 **`db` 서비스에 ports 매핑을 두지 않는다**(upstream 설계는
  "호스트에서는 pooler 로만 붙어라"). 그 상태에서는 `npm run dev`·`npm run dev:ro`·`prisma`·
  `scripts/*` 가 전부 `Can't reach database server at 127.0.0.1:55432` 로 죽는다.
  - ⚠️ **이걸 프로덕션 장애로 오판하지 말 것** — 앱은 컨테이너 네트워크로 DB 에 붙으므로
    `crm.ygrd.kr` 은 멀쩡하다. 실제로 2026-08-25 에 그렇게 한 번 헷갈렸다. 가르는 법:
    `curl -s -o /dev/null -w '%{http_code}' https://crm.ygrd.kr/login` 이 200 이고
    `docker ps` 가 healthy 면 **프로덕션은 정상이고 내 셸에 경로가 없는 것**이다.
  - ⛔ **pooler(5432/6543)로 우회하지 말 것** — Supavisor 는 사용자명에 테넌트 식별자
    (`postgres.<tenant>`)를 요구해 `.env` 의 맨 `postgres` 는 `FATAL: (ENOIDENTIFIER) no
    tenant identifier` 로 거절된다(실측). 자격증명을 고치는 것보다 포트를 여는 쪽이 변경 폭이
    작다는 것이 오너 결정이다.
  - **정본 경로 = compose override 의 루프백 매핑.** `supabase-docker/docker-compose.override.yml`
    이 `db` 에 `"127.0.0.1:55432:5432"` 를 얹는다(upstream 파일을 안 건드리므로 supabase
    업데이트에도 살아남는다). ⛔ **`0.0.0.0` 으로 바꾸지 말 것**: 이 머신이 프로덕션
    호스트라 접두사를 빼면 Postgres 가 전 인터페이스에 노출된다.
  - 🪤 **override 를 만들어 두는 것만으로는 적용되지 않는다.** 이 스택의 프로젝트 `.env` 에
    **`COMPOSE_FILE=docker-compose.yml`** 이 있어서 파일 목록이 명시 고정돼 있고, 그러면
    docker compose 의 **override 자동 탐색이 꺼진다**(2026-08-25 실측 — 파일을 두고
    `docker compose up -d db` 를 돌렸더니 재생성 없이 `Running` 만 뜨고 포트가 안 열렸다).
    ⛔ 「같은 디렉터리에 두면 자동으로 읽힌다」는 일반 상식을 이 스택에 적용하지 말 것.
    적용하려면 그 줄을 **`COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml`** 로
    바꾼다(구분자는 `COMPOSE_PATH_SEPARATOR` 기본값 `:`). 병합 결과는 쓰기 전에
    `docker compose config | grep 55432` 로 예행 확인할 수 있다 — `host_ip: 127.0.0.1` 까지
    함께 보인다.
    ⚠️ `-f` 로 매번 넘기는 방식(`docker compose -f … -f … up`)으로 때우지 말 것: 그 뒤의
    평범한 `docker compose restart`·재부팅 기동이 override 없이 돌아 **포트가 조용히 다시
    닫힌다.**
  - **적용 여부 확인:** `lsof -nP -iTCP:55432 -sTCP:LISTEN` 에 줄이 나오면 열린 것이다.
    안 열려 있으면 적용은 `docker compose up -d db`(컨테이너 **재생성** = 짧은 DB 다운타임,
    데이터는 named volume 이라 보존) — **프로덕션 중단이 따르므로 오너 조작이다.**
  - **포트가 닫힌 상태에서의 임시 우회(읽기 전용 조회용):**
    `docker exec supabase-db psql -U postgres -d postgres -c "<SQL>"`. 컨테이너 안에서 도는
    거라 포트와 무관하다. ⚠️ 이건 조회용 사다리일 뿐이고 `prisma`·`npm run dev` 는 못 살린다.
  - 🪤 **연결 불가가 자격증명 불일치를 가린다 — 포트를 열면 실패 메시지가 바뀐다.**
    2026-08-25 실측: 포트를 연 직후 실패 문구가 **`Authentication failed against database
    server`** 로 넘어갔다(Prisma 가 사용자명을 함께 찍는다). 레포 `.env` 의
    `DATABASE_URL` 비밀번호가 **08-13 컷오버 이전 값**으로 남아 있었고(길이부터 달랐다),
    그전까지는 **`Can't reach…` 가 그 사실을 덮고 있어서** 아무도 몰랐다.
    ⚠️ 그래서 「포트를 열었는데도 안 된다」를 포트 작업 실패로 되돌리지 말 것 — **에러
    문구가 `Can't reach` → `Authentication failed` 로 바뀌었다면 포트는 성공한 것**이고
    남은 것은 별개의 자격증명 문제다.
    - 정본 값은 셀프호스트 `supabase-docker/.env` 의 `POSTGRES_PASSWORD`(사용자는
      `postgres`). 레포 `.env` 는 git 미추적 로컬 파일이라 그 값으로 맞추면 된다.
    - ⛔ **비밀번호를 출력·기록하지 말 것**(P0, 레포 public). 대조는 값이 아니라 **지문**으로
      한다 — 두 파일에서 뽑아 `sha256` 앞 10자와 길이만 비교하면 일치 여부가 나온다.
    - ⚠️ 붙고 나면 `npm run dev`·`scripts/*` 가 **프로덕션에 쓰기까지** 닿는다. 확인·조회
      목적이면 `npm run dev:ro`(아래 항목, 쓰기 구조적 차단)를 기본으로 쓴다.

- **프로덕션 DB 로 가는 문은 전부 루프백 전용이다(2026-08-25 오너 확정·적용):**
  `supabase-db` 는 `127.0.0.1:55432`, 커넥션 풀러(`supavisor`)는 `127.0.0.1:5432` ·
  `127.0.0.1:6543`. 앱은 같은 머신의 호스트 프로세스라 루프백으로 충분하다(실측: 유일한
  클라이언트가 `127.0.0.1:6543` 으로 붙는 `next-server` 하나였다).
  - **왜 풀러까지 잠갔나:** 이 머신은 방화벽이 꺼져 있어 `0.0.0.0` 바인딩이면 **같은
    네트워크의 아무 기기나** 접속을 시도할 수 있었다. `db` 만 루프백에 묶고 풀러를 열어
    두는 것은 **같은 DB 로 가는 다른 문**을 열어 두는 것이라 의미가 없다.
  - ⛔ **되돌리지 말 것.** 다른 기기에서 붙어야 할 일이 생기면 바인딩을 넓히지 말고 SSH
    터널을 쓴다(포트를 넓히면 방화벽이 꺼진 상태에서 그대로 네트워크 노출이 된다).
  - 🪤 **`ports` 는 병합 시 치환이 아니라 「추가」다.** override 에 그냥 적으면 upstream 의
    `0.0.0.0` 매핑이 **그대로 남아 둘이 함께** 선언되고 포트가 충돌한다. 반드시
    **`ports: !override`** 로 목록 전체를 갈아끼운다(compose v2.24+ 태그, 이 스택 실측 동작).
  - 🪤 **`.env` 의 포트 값에 `127.0.0.1:` 을 붙이는 손쉬운 우회는 변수마다 성립 여부가
    다르다** — 겉보기엔 대칭이라 똑같이 다루기 쉽지만 아니다:
    - `POOLER_PROXY_PORT_TRANSACTION`(6543) — 사용처가 **ports 줄 1곳뿐**이라 붙여도 된다.
    - ⛔ `POSTGRES_PORT`(5432) — 사용처가 **12곳**이고 대부분 컨테이너 **내부 접속
      문자열**(`postgres://…@${POSTGRES_HOST}:${POSTGRES_PORT}/…` · `DB_PORT` · `PGPORT`)이라
      붙이는 순간 auth·rest·storage·meta·realtime 이 **전부 깨진다.**
    → 그래서 5432 는 `.env` 가 아니라 위 `!override` 로 처리한다.
  - **적용 전 예행 검증이 값싸다:** `docker compose config` 로 병합 결과를 계산해
    `host_ip` 가 의도대로 붙었는지, 그리고 `diff <(docker compose -f docker-compose.yml config)
    <(docker compose config)` 로 **차이가 의도한 포트 줄뿐인지** 확인한 뒤 재시작한다.
    재시작은 앱의 DB 경로를 끊으므로(풀러 경유) 프로덕션 중단이 따른다 — 오너 조작이다.
  - **재시작 후 기능 확인은 `/login` 으로 하지 말 것** — DB 를 안 탈 수 있어 200 이 나와도
    증명이 안 된다. **DB 조회가 반드시 일어나는 요청**(예: 존재하지 않는 포털 슬러그 →
    404)을 던지고, 그 직후 `lsof -nP -iTCP:6543 -sTCP:ESTABLISHED` 에 앱 프로세스가
    다시 붙었는지 본다.

- **읽기 전용 레인 `npm run dev:ro`(= `DB_READ_ONLY=1`, 2026-07-31):** 실데이터로
  화면·지표를 점검하되 **오조작 쓰기는 구조적으로 막는** 기본 레인이다. 판정 SSOT는
  `src/lib/db-read-only.ts`, 적용 지점은 `createPrismaClient`의 `withReadOnlyGuard`
  한 곳(데모·sqlite·postgres 세 갈래를 함께 감싼다). 계약은
  `db-read-only.contract.test.ts`.
  - **왜 필요한가:** 화면 렌더 경로(`page.tsx`·`layout.tsx`)에는 Prisma 쓰기가 없어
    "화면만 훑는" 점검은 원래 읽기뿐인데, 그것을 **강제하는 장치가 없어** 모든 세션이
    쓰기 가능 레인에 있었다. 저장 버튼 오조작 한 번이 곧 프로덕션 변경이다.
  - **`npm run dev`는 그대로 둔다** — 쓰기 기능 테스트에는 필요하다. 바뀌는 것은 어느
    쪽이 기본 습관인가뿐이고, 쓰기가 필요하면 의식적으로 레인을 바꾼다(`*_COLLECT_MODE`의
    명시 opt-in 패턴과 같은 모양).
  - **분류는 화이트리스트다** — 읽기 op만 통과시키고 모르는 op는 막는다. 블랙리스트로
    뒤집지 말 것: Prisma가 새 쓰기 op를 추가하면(6.x에서 `createManyAndReturn`·
    `updateManyAndReturn`이 그렇게 늘었다) 조용히 통과한다. raw는 용도로 가른다 —
    `$queryRaw` 통과(조회), `$executeRaw` 차단.
  - ⚠️ **오조작 방지선이지 권한 경계가 아니다.** 공유 Prisma 클라이언트를 탈 때만
    유효하므로 자체 `new PrismaClient()`를 만드는 스크립트나 psql 직결은 막지 못한다.
    신뢰할 수 없는 코드까지 막아야 하면 Postgres 레벨 읽기 전용 role이 별도로 필요하다.
  - **egress는 줄지 않는다** — 읽기가 곧 egress다. 이 레인의 목적은 사용량이 아니라
    쓰기 사고 방지다(로컬 dev의 화면 조회 egress는 전 화면 1바퀴가 수 MB 수준으로,
    Supabase 무료 쿼터 대비 무시할 만하다는 것이 2026-07-31 프록시 실측으로 확인됐다 —
    "로컬에 실데이터를 붙이면 사용량이 위험하다"는 우려는 근거가 없다).

- **수집 모드(`*_COLLECT_MODE`)는 명시 opt-in이다 — 미설정이면 거부된다:**
  해석 SSOT는 `src/lib/collect-mode.ts`(`resolveCollectMode`). 미설정(빈 문자열
  포함)은 **`mock`이 아니라 "미설정"** 이고, 호출부가 각자 거부한다 — 채널정보
  조회 라우트는 `500`, 크론 수집기 2종은 사유를 남기고 skip. **mock을 쓰려면
  값을 명시하라**(`INSTAGRAM_COLLECT_MODE=mock`).
  - **왜 이렇게 됐나(되돌리지 말 것):** 예전엔 `process.env.X || "mock"`이라
    **변수를 켰을 때가 아니라 없을 때** mock으로 떨어졌다. mock은 출처만
    가짜고 저장 경로는 실제라, 난수 팔로워가 `prisma.seller.update()` +
    `recordSellerMetricsSnapshot(..., "MOCK")`까지 도달했다. `npm run dev`의
    DB가 프로덕션이므로 **로컬 세션이 프로덕션을 오염시켰다** — 실측
    `SellersHistory.source="MOCK"` 14건·셀러 8명(2026-06-22·07-04·07-10).
  - **명시 `=mock`은 여전히 쓰는 mock이다.** 팔로워 수집기의 mock은 no-op이
    아니라 기존값 +50~200 증분을 저장한다. **이제 원격(비-sqlite) DB에서는 코드가
    거부한다** — 이 문단이 "켜지 말 것"이라는 서술뿐이던 동안 실제로 재발했기 때문이다
    (판정 `mockCollectBlockedReason`, 쓰기 차단선 `recordSellerMetricsSnapshot`,
    계약 `mock-collect-write-guard.contract.test.ts` — 정본 서술은 P7
    "Mock Collection = sqlite 전용"). mock 예행은 `npm run dev:local`이나
    `DATABASE_URL=file:./dev.db`로 한다. mock을 켜는 검증 스크립트 3종
    (`verify-instagram-collector`·`verify-youtube-collector`·`verify-cron`)은
    프로덕션 DB면 **임시 셀러를 만들기 전에** 중단한다(`scripts/assert-local-db.ts`).
  - 미인식 값(`mock|apify|api` 외)은 여전히 라우트에서 조용히 통과한다 —
    `instagram`·`youtube`가 수집기 쪽 정상 값이라 화이트리스트로 막으면
    프로덕션이 깨질 수 있어 의도적으로 남겨둔 잔여 구멍이다.
  - 오염 식별·정리는 `SellersHistory.source = "MOCK"` 행으로 한다(단
    `Seller.currentFollowers`에는 라벨이 남지 않는다).

- **Worktree Dev:** 세션 워크트리에서 dev 서버를 띄우려면 메인 레포
  `node_modules`를 심링크해야 한다(turbopack root는 `next.config.ts`가 자동
  계산). Prisma 클라이언트가 stale하면 `prisma generate`로 해소한다.

- **워크트리 실렌더 검증 경로(정본, 2026-08-18 실측):** 워크트리에서 UI 실렌더
  확인(DoD 3)은 **가능하다.** 종전에 "워크트리는 영구 fallback 고정이라 실렌더
  검증 불가"로 보고된 건은 **앱 버그가 아니라 계측 함정 3종**이었다. 순서대로
  밟는다.
  1. `preview_start({name: "wag-crm-dev-local-worktree"})` — 이 엔트리는 워크트리
     전용 포트 **3012**를 쓴다(메인 레포의 3002 레인과 겹치지 않는다).
  2. **`computer{action:"screenshot"}`를 먼저 한 번 호출해 페인트를 강제한다.**
  3. 그 다음에 `read_page`·`javascript_tool`로 판정한다.
  - **판정은 눈이 아니라 아래 지표로 한다** — fallback 과 실사이드바는 화면상
    구분이 안 된다(둘 다 48px 레일 + 빈 main). 쓸 지표는 이 둘이다:
    ```js
    // ① 갇힌 스테이징 div — 막힘 2 · 정상 0  (가장 확실한 판정)
    [...document.body.children].filter(e=>e.tagName==='DIV'&&e.hasAttribute('hidden')&&e.innerHTML.length>1000).length
    // ② 보이는 셸의 크기 — fallback 271B · 실셸 13만B 대
    [...document.body.children].find(e=>String(e.className).includes('sidebar-wrapper')).innerHTML.length
    ```
  - ⛔ **링크 개수(`a[href]`)로 판정하지 말 것** — 갇힌 div 안의 링크도
    `querySelectorAll` 에 잡혀서 **막힘 16 · 정상 18** 로 거의 차이가 없다(실측).
    `getBoundingClientRect()` 도 마찬가지로 패널이 가려져 있으면 전부 0 이라
    "안 그려졌다"와 구분되지 않는다.
  - ⚠️ **이 둘은 "그려졌는가"만 본다 — "살아 있는가"는 아니다.** 클릭·토글이 걸린
    검증이면 아래 **함정 ①-b** 의 하이드레이션 프로브를 반드시 함께 돌린다.

- **함정 ①(최우선) — 프리뷰 패널이 가려져 있으면 Suspense 가 영영 안 풀린다:**
  패널이 숨겨진(페인트되지 않은) 탭은 뷰포트가 **0x0**이고 렌더러가 스로틀돼
  **하이드레이션·reveal 이 진행되지 않는다.** 그동안 화면에는
  `SidebarLayoutFallback`(48px 레일 + 빈 main)만 남고, 스트리밍된 진짜 내용은
  `<div hidden>` 두 개(사이드바 58KB · 페이지 55KB)에 **갇힌 채로** 있다.
  - **콘솔 에러 0건 · `readyState:"complete"` · `NEXT-ROUTE-ANNOUNCER` 존재 ·
    사이드바 effect 의 API 요청까지 나가므로**, 앱이 고장 난 것처럼 보인다.
    2026-08-15 "워크트리 영구 fallback" 보고가 정확히 이것이었다.
  - **해소는 페인트 한 번이다** — `screenshot` 호출 직후 같은 탭에서 실측:
    갇힌 div 2→**0**, wrapper HTML 271B→**136,505B**, `main` 텍스트 0→**1,865**,
    링크 16→**18**, 사이드바 rect 0x0→**47x687**.
  - ⛔ **`javascript_tool` 이 "Browser pane is currently hidden" 으로 타임아웃나면
    그것이 곧 이 상태다** — 앱을 의심하기 전에 스크린샷부터 찍는다.

- **함정 ①-b — 페인트만으로 안 풀리는 잔여 상태(미하이드레이션):** 스로틀돼 있는
  동안 `app/layout.js` **청크 로드가 타임아웃**나면(`ChunkLoadError`), 나중에
  스크린샷으로 페인트를 강제해도 **DOM 만 그려지고 하이드레이션은 영영 안 붙는다.**
  - ⚠️ **위 판정 지표 두 개가 모두 정상이어도 이 상태일 수 있다** — 갇힌 div 0 ·
    셸 길이 정상인데 클릭·토글이 전혀 먹지 않는다. 계산값(rect·텍스트) 측정은
    되므로 "렌더 확인함"으로 통과시켜 놓고, 정작 상호작용 검증만 헛돌아
    "앱이 죽었다"로 오진하기 쉽다.
  - **상호작용이 필요한 검증에서는 이 프로브를 따로 돌린다** — 아무 버튼에서
    `Object.keys(el).some(k=>k.startsWith('__react'))` 가 **false 면 미하이드레이션**.
  - **처방은 reload**(같은 URL 로 navigate). 이미 패널이 떠 있으므로 청크가 정상
    로드된다.

- **함정 ② — `.claude/launch.json` 의 포트는 npm 스크립트가 이긴다:**
  `dev`·`dev:local`·`dev:ro`·`dev:demo` 는 전부 **`-p 3002` 를 하드코딩**한다.
  그런데 launch.json 엔트리들은 `"port": 3000, "autoPort": true` 였다 — 하네스는
  3000이 막혔다고 **임의의 빈 포트(예 53446)를 잡아 그 주소로 탭을 연다.**
  서버는 3002에 뜨는데 브라우저는 빈 포트를 보므로 **탭이 항상 죽는다.**
  2026-08-18 에 전 엔트리의 `port` 를 실제 값으로 맞추고 `autoPort` 를 제거했다.
  스크립트의 포트를 바꾸려면 `npm run dev:local -- -p <포트>` 처럼 **뒤에 붙인
  `-p` 가 이긴다**(실측).

- **함정 ③ — `localhost` 는 `::1` 로 먼저 풀리는데 dev 서버는 IPv4 전용이다:**
  `dev:local`·`dev:demo` 는 `-H 127.0.0.1` 로 **IPv4 에만** 바인딩한다. 하네스는
  기본적으로 `http://localhost:<포트>` 로 탭을 여는데 macOS 에서 `localhost` 는
  `::1` → `127.0.0.1` 순으로 풀린다. curl 은 fallback 하지만 **브라우저 탭은 그냥
  빈 화면이 된다.** 그래서 워크트리 엔트리에 `"url": "http://127.0.0.1:3012"` 를
  박아 뒀다(launch.json 이 지원하는 공식 필드). 새 엔트리를 만들 때도 `-H` 를
  쓰면 `url` 을 같이 적는다.

- **동시 실행 규칙(실측):** Next 의 중복 dev 서버 락은 **`.next` 단위, 즉 워크트리
  단위**다. 따라서 **서로 다른 워크트리는 포트만 다르면 동시에 dev 를 띄울 수
  있다**(실측: 3002 와 3098 동시 기동 성공). 막히는 경우는 둘뿐이다 —
  같은 워크트리에서 두 번 띄우면 `⨯ Another next dev server is already running`
  으로 거절하며 기존 주소를 알려 주고, **다른 워크트리가 같은 포트를 쓰면
  `EADDRINUSE` 로 그냥 죽는다**(Next 는 포트를 자동 증가시키지 않는다).
  - ⚠️ **이 죽음을 놓치면 오진이 시작된다.** 내 서버가 죽은 채 3002 를 열면
    **다른 워크트리의 앱**을 보게 되고, 내 트리에만 있는 라우트는 **404** 가 된다.
    이 404 는 루트 레이아웃 안에서 렌더돼 **앱 셸 + 빈 main** 으로 보이므로
    fallback 고정과 육안 구분이 불가능하다. 서버가 실제로 살아 있는지
    (`lsof -nP -iTCP:<포트> -sTCP:LISTEN`)부터 확인한다.

- **Test Landscape:** `npm test`(vitest 전체) · `npm run test:ci`(hermetic
  서브셋, CI `release-preflight.yml`과 동일) · `npm run test:e2e`(Playwright
  데스크톱). 계약 테스트 4종 — 포털 slug 예약(`portal-slug.test.ts`), 모바일
  breakpoint(`mobile-breakpoint-contract.test.ts`), 유료 스크래핑
  화이트리스트(`instagram-scrape-callers.contract.test.ts`), 포털 성과 출력
  (`content-performance.contract.test.tsx`) — 은 컨벤션의 기계 강제 장치다.
  깨지면 코드가 규칙을 어긴 것이니 테스트가 아니라 코드를 고친다(계약 자체의
  변경은 오너 승인 사안).

- **타입체크 범위는 둘로 갈라져 있다 — `npm run typecheck` 하나가 둘 다 돈다
  (2026-08-07):** 앱은 루트 `tsconfig.json`, 스크립트는 `tsconfig.scripts.json`이다.
  **루트에 scripts를 넣지 않는다** — 루트는 `next build`가 함께 쓰는 파일이라,
  거기 넣으면 운영 스크립트 하나가 깨질 때 프로덕션 빌드가 막힌다(scripts는 배포되는
  코드가 아니라 오너가 돌리는 도구다). CI 게이트는 `release:check` 번들 안의
  `typecheck:scripts`이고, 로컬 DoD도 같은 명령을 쓴다.
  - **왜 켰나:** 그전까지 `scripts/` 107개 파일이 **한 줄도 검사되지 않았다.** 켜자마자
    **실행하면 죽는 스크립트 4종**이 나왔다 — 개명된 심볼을 옛 이름으로 import(그래서
    import 단계에서 사망), 스키마에서 제거된 필드를 계속 전달(Prisma가 Unknown
    argument로 거부). 스크립트는 프로덕션 DB를 만지는 것이 많아(P0) 오히려 더 봐야
    하는 코드다.
  - ⚠️ **타입체크가 전부를 잡아 주지는 않는다.** 객체가 **중간 변수를 거쳐** Prisma로
    가면 초과 속성 검사가 작동하지 않는다(리터럴을 직접 넘길 때만 걸린다). 위 4종 중
    두 곳이 그렇게 숨어 있었고 눈으로 찾아야 했다. "타입체크 통과"를 "스키마와
    일치한다"로 읽지 말 것.
  - 🪤 **없어진 심볼을 봤을 때 개명부터 의심할 것.** `TRIPP_LEGACY_RULES`는 삭제가
    아니라 `TRIPP_GOLDEN_RULES`로 개명 + 테스트 픽스처로 이전된 것이었다. "없다"고
    단정하고 스크립트를 지웠으면 멀쩡한 도구를 잃을 뻔했다.

- **⚠️ `npm test` 통과는 CI 통과를 뜻하지 않는다 — 새 테스트는 `npm run test:ci`
  로도 돌려볼 것(실사고 2026-08-01):** 두 명령의 env 가 다르다. `test:ci` 는
  `HERMETIC_ONLY=1 DATABASE_URL=file:./dev.db DIRECT_URL=` 를 **강제**하는데, 로컬
  `npm test` 는 셸의 env 를 그대로 쓴다(보통 `DATABASE_URL` 미설정). 그래서
  **`isSqliteDatabaseUrl()` 로 분기하는 코드**는 두 환경에서 다른 길을 탄다 —
  대표적으로 `acquireGroupLock`(`campaignGroupService`)은 sqlite 면 `pg_advisory_xact_lock`
  을 **건너뛴다**. 락 호출을 단언하는 테스트를 새로 쓰고 로컬 전량 통과를 확인한 뒤
  PR 을 올렸는데 CI 에서 그 1건만 실패했다.
  - **처방은 제외 목록 추가가 아니라 테스트의 환경 독립화다.** `vitest.config.ts` 의
    `hermeticExcludes` 에 파일을 넣으면 그 파일의 **모든** 계약(소스 스캔 포함)이 CI 에서
    사라진다 — 락 하나 때문에 방어선 전체를 CI 밖으로 빼는 셈이다. `DATABASE_URL` 을
    테스트 안에서 명시적으로 세팅·복원해 **두 갈래(원격=락 획득 / sqlite=락 생략)를 각각
    고정**하면 어느 환경에서도 같은 결과가 나온다.
  - 기존 `hermeticExcludes` 2건(`campaignService.recalcRounds` ·
    `campaignGroupService.test.ts`)은 이 함정의 선례다 — 사유가 "Postgres 전용 동작"
    이라고 적혀 있다.

- **검증 판정 위생 — "없다"는 세 가지를 뜻할 수 있다 (실사고 3건, 2026-07-30~31):**
  원칙 정본은 전역 `~/.gemini/config/rules/rules-coding.md` §Verification Hygiene
  이다(①대상 없음 ②조회 범위 밖 ③기록만 없음의 3분법 — ①로 단정 금지, "이 도구가
  보는 범위가 무엇인가"를 먼저 묻는다 · 일시적 외부 오류의 구조적 원인 단정 금지 ·
  파이프 종료코드 은폐 — 2026-08-01 승격). 이 레포에서 반복된 실사례:
  - **기록의 부재 ≠ 대상의 부재:** `SalesCampaign.calendarEventIds=null` 을 보고
    "구글 캘린더에도 이벤트가 없다"고 보고했으나 오너가 화면에서 실물을 봤다.
    그 필드는 **CRM 이 추적 중인 것**만 담는다 — 추적이 끊긴 대상은 외부에 남는다.
    (같은 계열: P6 의 "classic protection API 404 를 무보호의 근거로 쓰지 말 것".)
  - **로깅되지 않는 변경을 "변경 없음"으로 읽지 말 것:** `ActivityLog` 는
    `assignedTo`·CREATE 만 남긴다. 캠페인 **기간 변경은 아예 기록되지 않으므로**
    "이력 0건"은 무변경의 증거가 아니다. 이력으로 원인을 못 가리면 그렇게 보고한다.
  - **일시적 외부 오류를 구조적 원인으로 단정하지 말 것:** 구글 토큰 갱신 400 을
    "로컬↔prod 키 불일치"로 추정해 여러 차례 "로컬에선 조회 불가"라고 보고했으나,
    오류 본문의 `error` 코드를 싣고 재시도하니 그냥 성공했다(일시 오류). **진단
    정보가 없으면 추정이 사실처럼 굳는다** — 상태코드만 남기는 실패 경로를 보면
    먼저 원인 코드를 드러내고 다시 판단한다.

- **로컬 테스트 실패를 레포 문제로 보고하지 말 것 (실사고 2026-07-30):** 귀속
  원칙 정본은 전역 `~/.gemini/config/rules/testing.md` §Failure Attribution 이다
  (선재 실패는 base 재현으로 분리 입증 · 로컬 실패 ≠ 레포 결함 · 총계는 베이스를
  맞춘 뒤에만 유의미 — 2026-08-01 승격). 이 레포의 실사례: 선재 실패
  14건(`instagram-collector-source`·`channel-info`)이 **CI 에서는 통과**했다. 로컬
  환경(캐시·env·생성물)이 원인인 경우가 흔하므로, 레포 결함으로 보고하기 전에 CI
  결과와 대조한다.
  - **전체 테스트 총계는 베이스를 맞춘 뒤에만 의미가 있다.** 로컬 `main` 이 5커밋
    뒤처진 채 돌린 첫 실행은 24건 실패였고 `origin/main` 으로 맞추자 0건이었다.
    **총계가 직전 실행과 다르면 먼저 베이스를 의심한다**(잘못된 베이스에서도 검증은
    통과하므로 "그린"이 안전을 보장하지 않는다).
  - **`better-sqlite3` prebuild 실패(`nodejs.org` `ETIMEDOUT`)는 인프라 flaky**다 —
    `gh run rerun --failed` 로 통과한다. 같은 run 의 `preflight` 가 fresh-install 을
    완주했다면 코드 문제가 아니라는 방증이다.

- **⏰ 시각 의존 테스트 시한폭탄 — 이 레포의 실사고 (2026-08-01, main 하루 차단):**
  **규칙 정본은 전역 `~/.gemini/config/rules/testing.md`(Time-Dependent Tests)다** —
  기본형(상대 날짜)·처방(`toFake: ['Date']`)·전역 고정 금지 근거·진단 절차가 거기 있다.
  여기엔 **이 레포에서 실제로 터진 사례와 좌표**만 남긴다(전역 룰에 프로젝트 경로·상수를
  올리면 다른 프로젝트에서 노이즈가 된다).
  - **무엇이 터졌나:** `naver-order-sync.test.ts` 의 두 describe 가 고정 날짜 픽스처
    (`snapshotDate: '2026-07-01'`)를 쓰는데, 동기화 경로는 보존 창
    (**`SNAPSHOT_WINDOW_DAYS`=30**, `enumerateSnapshotDateKeys` 의 `earliestKey`)을 시스템
    시각 기준으로 자른다. KST 날짜가 8/1 로 넘어가며 창 시작 키가 `2026-07-01`→`2026-07-02`
    가 되어 픽스처가 창 밖으로 떨어졌다(PR #207).
  - **판정 근거(이 레포의 재사용 가능한 관측):** 07-31 **14:44Z** #205 통과 → **15:15Z**
    실패, 그 사이 코드 변경은 **문서 1줄뿐**. `gh pr checks <직전 머지 PR> --json
    name,bucket,completedAt` 로 마지막 통과 시각을 뽑아 대조하면 몇 분 만에 갈린다.
  - **이 레포에서 같은 위험을 갖는 곳:** 시각 기준 창을 쓰는 코드가
    `SNAPSHOT_WINDOW_DAYS`(30일) 외에도 있다 — 재캠페인·휴면 판정(90/180일),
    `isSnapshotStale`(14일). 이들을 **고정 날짜 픽스처로** 테스트하면 같은 폭탄이다.
  - **곁조사(2026-08-01):** 고정 날짜를 쓰는 테스트 216파일 중 창 로직을 동반한 4개를
    확인했고 전부 상대 날짜이거나 시스템 시각 미사용이라 **추가 폭탄은 미발견**이다 —
    단 키워드 스캔이라 완전성 보증은 아니다.

- **워크트리에서 뜬 `?? .claude/*.local.md` 는 파일 문제가 아니라 브랜치 위치 문제다
  (일반 원리는 전역 `~/.gemini/config/AGENTS.md` §「Shared-Tree Hygiene」— 2026-08-01):**
  `.gitignore` 는 **체크아웃된 트리에 종속**이라, 세션 브랜치가 그 무시 규칙을 담은
  커밋보다 앞서 있으면 무시되던 파일이 갑자기 추적 후보로 뜬다. 파일을 지우거나
  `.gitignore` 를 다시 고치기 전에 **현재 브랜치가 어디인지** 먼저 확인한다.
