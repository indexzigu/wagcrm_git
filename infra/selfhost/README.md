# Self-host (iMac) 운영 가이드

WAG CRM 을 Vercel 에서 오너 소유 iMac 으로 이전하는 셀프호스트 계층. 앱
자체는 macOS 네이티브(launchd)로 돌고, Supabase 만 Docker 로 띄운다 —
컨테이너화를 앱까지 확장하지 않는 이유는 아래 "왜 앱은 컨테이너가
아닌가"를 참고.

## 구성 요소 (8개)

| 구성 요소 | 실행 방식 | 역할 |
| --- | --- | --- |
| Supabase | Docker (compose) | Postgres·Auth 등 DB 스택 전용. 앱과 분리 |
| 앱 (Next.js) | 호스트 네이티브 (launchd, 이 문서) | `127.0.0.1:3000` 상주, `.live/current/server.js` (⛔ 종전 `.next/standalone/server.js` 는 SUPERSEDED — 2026-08-29 빌드 트리/서빙 트리 분리) |
| cloudflared | 호스트 네이티브 (launchd, 아래 "cloudflared 터널" 절 및 "최초 기동 순서") | 외부 도메인 → 로컬 앱 터널 |
| 크론 | 호스트 네이티브 스크립트 (별도 Task) | `run-cron.sh` 가 `curl 127.0.0.1:3000/api/cron/<job>` 호출 |
| 백업 | 호스트 네이티브 스크립트 + launchd (아래 "백업" 절) | `backup.sh`(일간, DB → R2) + `backup-weekly.sh`(주간, DB+스토리지 → Google Drive), `restore-drill.sh` 로 복원 리허설 |
| **프리뷰 앱** | 호스트 네이티브 (launchd `kr.ygrd.wagcrm.preview`, **온디맨드**) | `127.0.0.1:3001`. `preview.sh up` 으로 열고 `down` 으로 닫는다. 별도 체크아웃 `~/selfhost/wagcrm-preview` (아래 "프리뷰(스테이징) 레인") |
| **프리뷰 DB** | Docker (단독 컨테이너 `wagcrm-preview-db`, **온디맨드**) | `127.0.0.1:55432`. `preview.sh up` 이 매번 최신 백업으로 재구축, `down` 이 삭제 |
| **메뉴바 앱** | 호스트 네이티브 (launchd `kr.ygrd.wagcrm.menubar`) | 오너용 상태 표시 + 프리뷰 온·오프 화면. `install-menubar.sh` 로 설치 (아래 "메뉴바 앱" 절) |
| **CI 러너** | Colima VM (Linux) + VM 안 systemd (**프로덕션 Docker 와 별개 VM**) | GitHub Actions `release-preflight` 자가호스트 러너. VM 상시기동은 `brew services start colima` (아래 "GitHub Actions 자가호스트 러너" 절, 판단 규칙은 P6) |

## 메뉴바 앱 (WAG 서버)

오너가 메뉴바에서 서버 상태를 한눈에 보고 프리뷰를 켜고 끄는 앱이다.
설계 정본: `docs/private/specs/2026-08-14-menubar-server-control-design.md`.

- **설치(1회, 코드 갱신 시 재실행):** `bash ~/selfhost/wagcrm/infra/selfhost/install-menubar.sh`
  — 빌드 → `~/Applications/WagServerBar.app` 설치 → 로그인 자동 시작 등록 → 기동 확인.
- **아이콘이 상태를 말한다:** 평소엔 서버 모양, 문제가 있으면 경고 삼각형.
  개발 서버나 프리뷰가 켜져 있는 동안 `●` 점이 붙는다(끄는 것을 잊지 않게 —
  둘 다 켜져 있는 동안 프로덕션 사본 DB 가 디스크에 있다).
- **개발 서버가 주 레인이다(#383 오너 결론 — 프리뷰는 부기능).** 켜기는
  `dev.sh up`(오너 확정: 켜질 때마다 최신 백업으로 DB ~11초 재구축 → `next dev`
  포트 **3002** → 브라우저 자동 오픈), 끄기는 `dev.sh down`(서버 종료 + 프리뷰가
  닫혀 있으면 DB 컨테이너까지 정리 — 사본 미상주 원칙). 포트 규약
  3000=프로덕션 / 3001=프리뷰 / 3002=개발은 `start-server.command`(#387)와 공유.
  가드 계약: `scripts/__tests__/dev-server-control.test.ts`(launchd 소유 kill 거부·
  이름 가드·프로덕션 리터럴 부재).
- **판정은 앱이 하지 않는다.** 상태는 `status.sh`(읽기 전용, JSON — 계약
  `scripts/__tests__/menubar-status.test.ts`), 온·오프는 `dev.sh`/`preview.sh` 를
  subprocess 로 부를 뿐이다. ⛔ 앱(Swift)에 `docker`·`launchctl`·`rm` 직접
  호출을 넣지 말 것 — 스크립트의 프로덕션 보호 가드를 우회한다(계약
  `scripts/__tests__/menubar-app-delegation.test.ts` 가 소스 스캔으로 막는다).
- **새 검사 항목이 필요하면** Swift 가 아니라 `status.sh` 에 추가하고
  `menubar-status.test.ts` 에 판정 케이스를 함께 넣는다. 화면 문구(detail)도
  스크립트 쪽에서 완성한다 — 운영자 언어로.
- **`~/selfhost/logs/status-unknown-streak.tsv`** — 지속 「확인 불가」 승격(설계 정본
  `docs/private/specs/2026-08-19-sustained-unknown-escalation-design.md`)이 쓰는
  `status.sh` 자체 상태 파일이다(key·최초관측epoch·연속횟수). 지워도 안전하다 — 다음
  폴링부터 그 키의 연속이 1부터 다시 세어질 뿐이고(승격이 늦어짐), 다른 판정에는
  영향이 없다.
- **`~/selfhost/logs/alert-history.tsv`** — `notify.sh` 가 **실제로 나간 발송**만
  덧붙이는 이력이다(`<epoch><TAB>키<TAB>제목<TAB>상세`). 옆에 있는 `alert-sent.tsv` 는
  이력이 아니라 **억제 상태**라 회복 시 `clear` 가 그 행을 지운다 — 그래서 사후에
  "무엇이 언제 나갔나"를 되짚으려면 이 파일을 본다(2026-08-25 에 실제로 필요했다).
  지워도 운영에는 영향이 없다(조사 자료만 잃는다). 회전 장치는 없다 — 하루 5줄 안팎이다.
- **프리뷰 → 개발서버 대체(#383 후속) 시:** `menubar/Sources/Constants.swift` 의
  `laneScript`·`laneName` 만 바꾼다.
- **안 뜨면:** `pgrep -x WagServerBar` → `~/Library/Logs/wagserverbar.log` →
  `install-menubar.sh` 재실행 순으로 확인한다. 자동 시작만 떼려면
  `launchctl bootout gui/$(id -u)/kr.ygrd.wagcrm.menubar && rm ~/Library/LaunchAgents/kr.ygrd.wagcrm.menubar.plist`.

## 프리뷰(스테이징) 레인

기능·UI·디자인 변경을 **프로덕션 데이터를 건드리지 않고** 실화면으로 확인하는 곳이다.
인증만 운영 스택의 GoTrue 를 공유하고(같은 계정으로 로그인), **그 외 모든 상태는 분리**한다.

| | 프로덕션 | 프리뷰 |
| --- | --- | --- |
| 도메인 | `crm.ygrd.kr` | `crm-test.ygrd.kr` |
| 포트 | `127.0.0.1:3000` | `127.0.0.1:3001` |
| 체크아웃 | `~/selfhost/wagcrm` | `~/selfhost/wagcrm-preview` |
| launchd 라벨 | `kr.ygrd.wagcrm.app` | `kr.ygrd.wagcrm.preview` |
| DB | `supabase-db` (풀러 `127.0.0.1:6543`) | `wagcrm-preview-db` (`127.0.0.1:55432` 직결) |
| 배포 마커 | `~/selfhost/logs/deployed.sha` | `~/selfhost/logs/deployed.preview.sha` |
| 스토리지 버킷 | `crm-assets` · `seller-media` | `crm-assets-preview` · `seller-media-preview` |
| 앱 크론 | 전량 (`run-cron.sh`) | **없음** |
| 추종 브랜치 | `main` 고정 | `up <브랜치>` 가 지정(생략 시 `main`) |

두 레인은 `deploy.sh`·`run-app.sh` 를 **공유**하고 env 3개로만 갈린다:

| env | 프로덕션 기본값 | 프리뷰가 주는 값 |
| --- | --- | --- |
| `APP_PORT` | `3000` | `3001` |
| `APP_LAUNCHD_LABEL` | `kr.ygrd.wagcrm.app` | `kr.ygrd.wagcrm.preview` |
| `APP_TRACK_BRANCH` | (안 줌 → `main`) | `up` 에 넘긴 브랜치 |

오버라이드를 주지 않으면 프로덕션 기본값 그대로이며, 그 불변식은
`scripts/__tests__/selfhost-lane-defaults.test.ts` 가 고정한다.

⚠️ **`APP_TRACK_BRANCH` 는 프로덕션 레인에서 거부된다**(무시가 아니라 `deploy.sh` 가
exit 1 로 중단). 프리뷰를 만지던 셸에 `export APP_TRACK_BRANCH=…` 가 남은 채
프로덕션 배포를 돌리면 프로덕션이 기능 브랜치를 빌드해 서빙하는데, PID 교체·
헬스체크·DB 프로브가 전부 통과하고 마커까지 갱신돼 **조용한 오배포**가 된다.
그래서 값이 `main` 이어도 거부한다 — 설정돼 있다는 것 자체가 셸 오염의 신호다.
`unset APP_TRACK_BRANCH` 후 다시 실행하면 된다.

### ⚠️ 프리뷰 DB 는 프로덕션 사본이라 민감도가 같다

`preview-db.sh` 는 R2 의 최신 백업(`public-data-only.sql.gz`)을 그대로 복원한다 —
셀러 실명·주민등록번호 암호문·매출이 **전부 들어 있다.** "테스트 서버니까 느슨해도
된다"는 판단을 하지 않는다. 외부인 차단은 프로덕션과 **같은 인가 게이트**
(`src/lib/auth-allowlist.ts` — Supabase `app_metadata.status`/`role`)가 담당하며,
프리뷰 `.env` 에도 `VERCEL_ENV=production` 을 그대로 둔다(우회 레인 2차 방어 유지).
`AGENT_BYPASS_TOKEN` 은 프리뷰에도 설정하지 않는다.

### ⚠️ 프리뷰에는 앱 크론을 설치하지 않는다

프리뷰에서 크론이 돌면 발주 메일·네이버 동기화 같은 **실제 외부 부수효과**가
프로덕션 사본 데이터를 근거로 발화한다. 그래서 레포의 `infra/selfhost/crontab`
**파일**에는 이제 프리뷰 관련 줄이 전혀 없다 — 예전에 있던 일일 새로고침 잡
(`preview-db.sh`)은 `preview.sh up` 이 열 때마다 DB 를 재구축하게 되면서 필요가
없어졌다. ⛔ 그 잡이든 다른 앱 크론이든 이 파일에 프리뷰 줄을 다시 추가하지 말 것.

⚠️ **파일을 고친 것과 기계가 그렇게 도는 것은 다르다 — 이 제거는 crontab 을 재설치하기
전까지 무효다.** 그 전까지는 **05:30 잡이 그대로 살아 있어** 프리뷰를 닫아둔 밤에도 DB
컨테이너를 매일 되살린다 — 온디맨드 전환이 막으려던 바로 그 결과다. 게다가
`preview.sh status` 는 그 상황에서도 "down" 이라고 답한다(상태 SSOT 가 컨테이너가 아니라
plist 이기 때문이다). 재설치 절차와 앱 크론 개수 검증은 아래 「앱 크론」 절이 정본이다 —
여기서 되풀이하지 않는다. 재설치 뒤 **이 레인에서** 따로 볼 것은 설치본에 프리뷰 줄이
남지 않았다는 것 하나다:

```bash
crontab -l | grep -c preview-db.sh   # → 0
```

위 표의 앱 크론(`run-cron.sh`)은 이 변경과 무관하며 그대로 유지된다. 자세한 열고/닫기
동작은 아래 "열고 닫기 — 온디맨드 운영" 절을 참고.

### 열고 닫기 — 온디맨드 운영

프리뷰는 상시 가동이 아니다. 작업을 확인할 때 열고, 끝나면 닫는다. 닫힌 동안
`crm-test.ygrd.kr` 은 502 가 정상이다.

**`down` 이 지우는 것 — 정확히:**

| | 닫은 뒤 |
| --- | --- |
| 프리뷰 DB 컨테이너(`wagcrm-preview-db`) | **삭제됨.** 사본 데이터셋 자체는 디스크에서 사라진다 |
| 앱 서비스 · plist | 삭제됨 |
| 빌드 산출물 `~/selfhost/wagcrm-preview/.next` | **삭제됨** — 그 안에 프리렌더된 사본 데이터가 들어 있기 때문이다(아래) |
| 배포 마커 `~/selfhost/logs/deployed.preview.sha` | 삭제됨(산출물을 지웠으므로 함께 — 아래 「재오픈 비용」) |

⛔ **종전 서술 "빌드 산출물은 남는다"는 SUPERSEDED**(2026-08-13 오너 확정으로
`down` 이 지우게 바뀌었다). 근거: 이 앱은 `cacheComponents: true` 아래에서 빌드
타임에 실제 DB 를 읽어 페이지를 프리렌더한다(`src/lib/cached-crm-data.ts`·
`cached-portal-data.ts` 의 `"use cache"`). 프리뷰 빌드는 그 DB 가 프로덕션 사본이므로,
정산·셀러·딜·파트너·손익 등 DB 를 읽는 화면의 프리렌더 결과
(`.next/server/app/**.rsc`·`.html` 과 서빙 트리 `.live/releases/*/.next/server/app/**`
안의 같은 사본)에 **셀러 레코드가 직렬화된 채로 들어간다.** ⛔ 종전 서술
「`.next/standalone/` 안의 같은 사본」은 SUPERSEDED — 2026-08-29 부터 그 사본은
`.live` 로 옮겨진다(`down` 이 두 경로를 **모두** 지운다). DB 컨테이너만 지우고 이것을 남기면, "안 쓰는
동안 사본이 존재하지 않는다"는 온디맨드의 기준을 **데이터의 절반에만** 적용하는
셈이었다. 이제 닫은 뒤 프로덕션 사본에서 나온 것은 디스크에 남지 않는다.

`down` 은 이 재귀 삭제를 **추측으로 하지 않는다.** 체크아웃 경로는 스크립트 상단에서
`~/selfhost/wagcrm-preview` 와 **정확 일치**로 확인하고(⚠️ 프로덕션 체크아웃
`~/selfhost/wagcrm` 이 프리뷰 경로의 **접두사**라 부분일치 검사는 두 경로를 못
가른다 — 이 파일과 `preview-control.test.ts` 양쪽에 이유가 적혀 있다), 삭제 직전
그 디렉터리가 실제 git 체크아웃인지 다시 본다. 확인되지 않으면 지우지 않고 exit 1
한다. 삭제 후에는 **부재를 확인**하고, 남아 있으면 실패로 보고한다.

**재오픈 비용 — `up` 은 이제 항상 빌드한다.** 산출물과 함께 배포 마커를 지우기
때문이다. 마커를 남기면 같은 커밋을 다시 열 때 `deploy.sh` 가 "변경 없음"으로
조기 종료해 **빌드를 건너뛰고**, 산출물 없는 서비스가 올라가 `up` 의 헬스체크가
실패한다(= 프리뷰가 안 열린다). 마커의 의미가 "이 SHA 의 빌드가 배포돼 서빙 중"인
이상, 닫은 뒤에 남겨두는 것 자체가 거짓이기도 하다. 프로덕션 마커
(`deployed.sha`)는 파일명이 달라 이 삭제와 무관하며, "빌드 실패를 배포로 기록하지
않는다"는 마커 본래 목적도 두 레인 모두 그대로다.

```bash
bash ~/selfhost/wagcrm-preview/infra/selfhost/preview.sh up            # main 을 연다
bash ~/selfhost/wagcrm-preview/infra/selfhost/preview.sh up <브랜치>   # 머지 전 브랜치를 연다
bash ~/selfhost/wagcrm-preview/infra/selfhost/preview.sh status
bash ~/selfhost/wagcrm-preview/infra/selfhost/preview.sh down
```

- `up` 은 매번 DB 를 최신 백업으로 재구축한다(~11초) — "지금 보는 데이터가 언제
  것인가"를 물을 필요가 없다. **닫았다 다시 여는 경우는 커밋이 같아도 전량
  빌드한다**(`down` 이 산출물과 마커를 함께 지우므로). 즉 열기까지 DB 11초 + 빌드
  몇 분을 잡아야 한다 — "재오픈은 즉시"는 이제 사실이 아니다. ⛔ 종전 서술 "같은
  커밋을 다시 열면 즉시 뜬다"는 SUPERSEDED. 빌드를 건너뛰는 경로는 `down` 없이
  `up` 을 연달아 실행할 때만 남는다(그때는 이전 산출물이 그대로 있어 정상이다).
- `down` 은 앱 서비스·plist·DB 컨테이너·빌드 산출물·배포 마커를 전부 지우고 **다섯의
  부재를 확인한 뒤에만** 성공을 보고한다(멱등 — 이미 내려가 있으면 그대로 exit 0). 하나라도
  남아 있으면 무엇이 남았는지 이름을 대며 exit 1 한다. docker 데몬에 못 붙어 확인
  자체가 안 된 경우도 실패로 친다 — "확인 못 함"을 "없음"으로 읽지 않기 위해서다.
  **plist 를 지우는 것이 핵심이다** — 남아 있으면 launchd 가 로그인 시 다시 로드해
  재부팅이 프리뷰를 되살린다.
- 상태 판정의 SSOT 는 `~/Library/LaunchAgents/kr.ygrd.wagcrm.preview.plist` 존재 여부다.
  `status` 는 **체크아웃 브랜치와 실제 서빙 중인 빌드를 따로** 보여준다 — `up` 은
  체크아웃을 먼저 옮기고 그 다음 빌드하므로, 빌드가 실패하면 서비스는 이전 빌드를
  서빙하는데 체크아웃만 새 브랜치인 상태가 된다. 그때 `status` 가 불일치를 경고한다.
- 일일 새로고침 크론은 없다(온디맨드 전환 때 제거 — 꺼놔도 매일 밤 DB 를 되살리는
  부작용만 남기 때문). ⛔ 되살리지 말 것. 단, 그 제거가 기계에 반영되려면 crontab
  재설치가 필요하다(위 "프리뷰에는 앱 크론을 설치하지 않는다" 절).

⚠️ **`up <브랜치>` 는 그 브랜치의 셸 스크립트를 이 기계에서 실행한다.** `preview.sh`
는 체크아웃을 먼저 그 브랜치로 옮긴 뒤 **그 브랜치에 있는** `preview-db.sh`·
`deploy.sh` 를 부르고, `deploy.sh` 는 프리뷰 `.env`(실제 시크릿)를 로드한 상태에서
`npm install`(postinstall 훅 포함)과 빌드를 돌린다. 즉 머지 전 브랜치를 여는 것은
**아직 리뷰되지 않은 코드에 프로덕션 기계의 셸을 내주는 일**이다 — 온디맨드 전환
전에는 리뷰를 통과한 `main` 만 여기서 돌았다. 소스 스캔 계약
(`preview-control.test.ts` 등)은 머지된 사본만 검사하므로 이 경로를 막지 못한다.
이 레포는 오너가 유일한 푸시 주체라 공격면이라기보다 **실수면**이다(예: 남의 PR
브랜치를 무심코 여는 것). 브랜치 출처를 확인하고 열 것.

## GitHub Actions 자가호스트 러너 (release-preflight)

`release-preflight.yml` 두 잡(`preflight`·`test`)을 받는 자가호스트 러너다. **왜
옮겼는지·폴백 토글·전량 이전 금지** 같은 판단 규칙의 정본은
`docs/agents/deployment.md` 「Self-Hosted Preflight Runner」(P6)이고, 여기는 운영
좌표만 둔다.

- **호스트 실측(2026-08-27):** Intel i5-10600 — **물리 6코어 · 논리 12스레드**, 메모리
  32GiB. VM 의 `cpu` 는 논리 스레드에서 떼어 오므로, 그 값을 정할 때 보는 것은 물리
  코어 수가 아니라 **호스트에 몇 개를 남기는가**다(판단 근거의 정본은 P6).
- **토폴로지:** 호스트에 Colima VM(Ubuntu, CPU 4 · 메모리 8GB · 디스크 30GB) 1개,
  그 안에 러너 **활성 2개**(`imac-colima-1`·`-2`) + **예비 1개**(`imac-colima-3` —
  등록·바이너리는 남기고 systemd 정지·disable). 각각 별도 디렉터리
  `~/actions-runner`·`-2`·`-3` 와 systemd 서비스다. `preflight` 잡의
  `services: postgres` 가 Linux 러너 전용이라 VM 이 필수다. 프로덕션 Supabase 가 도는
  Docker Desktop 과는 **완전 분리**된 별개 VM 이다.
- ⚠️ **러너 1개 = 동시 잡 1개다 — 병렬성은 CPU 코어 수가 아니라 러너 인스턴스 수가
  정한다.** 워크플로의 두 잡(`preflight`·`test`)은 `needs` 의존이 없어 원래 병렬인데,
  러너가 1개면 받아줄 자리가 없어 **줄을 선다**(2026-08-26 실측: 대기 3건, 최장 ~50분).
  ⛔ **활성 2개가 상한이다 — 3개 동시는 당일 실측으로 기각됐다**(그때 VM 은 **8 vCPU**
  였다 — 2026-08-27 부터 4 라 이 기각은 더 강하게 성립한다. 8 vCPU 에 잡 3개가
  겹치면 vitest 워커 상한을 걸어도 빌드·`npm ci` 경합으로 5초 타임아웃 무더기 —
  판단 근거의 정본은 P6 「Self-Hosted Preflight Runner」). 메모리 상한 8GB 도 활성
  2개 기준이다(잡 2개 동시 피크 6.0GB 실측 — 3개면 설치 단계만 7.2GB 라 부족).
  러너 3개로 되돌리려면 메모리 상한 12GB+ · `cpu` 8 이상과 **함께** 올리고, 예비 러너 기동은
  `colima ssh -- sudo systemctl enable --now actions.runner.indexzigu-wagcrm.imac-colima-3.service`.
- ⛔ **`~/.colima/default/colima.yaml` 의 `autoActivate: false` 를 유지할 것.** 기본값
  true 는 colima 기동 시 호스트 docker 컨텍스트를 `colima` 로 바꿔치기한다 — 프로덕션
  스택을 조작하는 모든 스크립트가 현재 컨텍스트를 쓰므로, 이 값이 되살아나면 그
  스크립트들이 빈 VM 을 상대로 돈다(P6 🪤). 확인:
  `docker context ls` 의 `*` 가 `desktop-linux` 에 있어야 정상.

### 상태 확인

```bash
colima status                       # VM 이 떠 있나
brew services info colima           # launchd 등록·기동 상태
colima ssh -- systemctl list-units 'actions.runner.*' --no-pager --plain
gh api repos/indexzigu/wagcrm_git/actions/runners --jq '.runners[] | "\(.name) \(.status) busy=\(.busy)"'
```

마지막 명령에서 활성 러너 **`imac-colima-1`·`-2` 가 `online`** 이면 끝(`-3` 은 예비라
`offline` 이 정상). 일부만 `offline` 이면 그 러너의
systemd 서비스만 죽은 것이고(VM 은 살아 있다), 전부 `offline` 이면 VM 부터 본다.
`busy=true` 3개 + 큐 대기는 정상 포화이지 장애가 아니다.

### 호스트 메모리 점유 확인

⛔ **`limactl` 프로세스의 RSS 로 재면 안 된다 — 게스트 메모리가 거기 안 잡힌다**(잡이
아무리 돌아도 100MiB 안팎만 나와서 "거의 점유 안 한다"는 틀린 결론이 나온다). VM 메모리는
macOS 가 **별도 XPC 헬퍼 프로세스**에 잡아둔다:

```bash
for p in $(pgrep -f com.apple.Virtualization.VirtualMachine); do
  echo "pid=$p 경과=$(ps -o etime= -p $p)"; footprint -p $p | grep phys_footprint:
done
```

프로세스가 2개 나온다 — 기동 경과가 **짧은 쪽이 CI VM(colima)**, 오래된 쪽이 프로덕션
Docker Desktop VM 이다.

⚠️ **읽는 법:** CI VM 은 설정된 메모리 상한까지 올라가 **거기서 머문다**(게스트가 그 뒤
메모리를 비워도 호스트로 돌아오지 않는다 — 반환 통로가 없다). 그래서 이 숫자가 상한에
붙어 있는 것은 고장이 아니라 **정상 동작**이고, 상한을 바꾸는 것 말고는 줄일 방법이 없다.
회수하려면 VM 재기동이 필요한데 그건 러너를 죽인다. 판정 근거와 실측은 P6
`docs/agents/deployment.md` 「Self-Hosted Preflight Runner」의 메모리 🪤 항목.

### 최초 설치 / 재설치

```bash
brew install colima docker
colima start --cpu 4 --memory 8 --disk 30
# ⛔ 이 직후 컨텍스트 확인 — colima 가 가로챘으면 되돌린다
docker context use desktop-linux
sed -i.bak 's/^autoActivate: true$/autoActivate: false/' ~/.colima/default/colima.yaml && rm -f ~/.colima/default/colima.yaml.bak
# VM 안 러너 (버전은 gh api repos/actions/runner/releases/latest 로 확인)
colima ssh   # 이후 VM 안에서:
#   sudo apt-get update && sudo apt-get install -y jq build-essential python3-setuptools sqlite3
#     (전부 GitHub 러너에는 기본 탑재라 맨 VM 에서만 터지는 것들이다 — 최초 구축 때 실측:
#      build-essential 부재 → better-sqlite3 프리빌드 없는 node 버전에서 node-gyp 폴백이
#      죽어 npm ci 전체 실패 · sqlite3 CLI 부재 → vitest global-setup 의 VACUUM 이
#      spawnSync ENOENT 로 test 잡 실패)
#   mkdir -p ~/actions-runner && cd ~/actions-runner
#   curl -sSLo runner.tar.gz https://github.com/actions/runner/releases/download/v<VER>/actions-runner-linux-x64-<VER>.tar.gz
#   tar xzf runner.tar.gz && rm runner.tar.gz && sudo ./bin/installdependencies.sh
#   ./config.sh --url https://github.com/indexzigu/wagcrm_git --token <등록토큰> --name imac-colima-1 --unattended
#   sudo ./svc.sh install z9 && sudo ./svc.sh start
# 러너 2·3번(동시 실행 자리를 늘린다 — 위 토폴로지 ⚠️ 참조). 디렉터리를 따로 두고
# 같은 tarball 을 다시 풀며, 등록 토큰은 러너마다 새로 발급한다:
#   for n in 2 3; do
#     mkdir -p ~/actions-runner-$n && tar xzf runner.tar.gz -C ~/actions-runner-$n
#     (cd ~/actions-runner-$n && ./config.sh --url https://github.com/indexzigu/wagcrm_git \
#        --token <등록토큰> --name imac-colima-$n --work _work --unattended --replace
#      sudo ./svc.sh install z9 && sudo ./svc.sh start)
#   done
#   ⛔ 러너 1번 디렉터리를 cp 로 복제하지 말 것 — .runner/.credentials 가 함께 복사돼
#      같은 신원 2개가 등록을 서로 밀어낸다. 반드시 tarball 에서 새로 푼다.
#   ⛔ 등록 토큰을 명령줄 인자로 그대로 두지 말 것(VM 안 `ps` 에 노출) — 파이프로
#      넘긴다: gh api -X POST .../registration-token --jq .token | colima ssh -- \
#        bash -c 'read -r T; cd ~/actions-runner-2 && ./config.sh ... --token "$T" ...'
# 상시기동(재부팅 생존):
brew services start colima
```

등록 토큰은 1시간짜리 일회용이다(러너에 남지 않는다):
`gh api -X POST repos/indexzigu/wagcrm_git/actions/runners/registration-token --jq .token`.
재등록(레포 이관·러너 교체)은 VM 안에서 `./config.sh remove --token <제거토큰>` 후 위
`config.sh` 부터 다시.

- **재부팅 흐름:** launchd(`homebrew.mxcl.colima`) → colima VM 부팅 → VM 안 systemd 가
  활성 러너 서비스(`enabled` 인 `-1`·`-2`)를 자동 기동. 사람이 할 일 없음(예비 `-3` 은
  disable 이라 재부팅해도 안 뜬다 — 의도된 상태).
- **VM 크기를 바꿀 때:** `~/.colima/default/colima.yaml` 의 `cpu`·`memory` 를 고치고
  `brew services restart colima`. launchd 가 `colima start -f` 를 인자 없이 돌리므로
  크기는 **이 yaml 이 정본**이다(`colima start --cpu ...` 로 준 값은 재기동 때 잊힌다).
  재시작은 그 순간 돌던 잡을 끊으므로 러너가 전부 `busy=false` 일 때 한다.
  ⚠️ **판정 기준은 「큐가 비었나」가 아니라 「러너가 `busy=false` 인가」다** — 아직 배정
  안 된 대기 잡은 러너가 사라져도 줄에 남지만, 이미 러너에 얹힌 잡은 그대로 죽는다
  (2026-08-27 OOM 사고의 `cancelled` 가 그 모양이다). 확인:
  `gh api repos/indexzigu/wagcrm_git/actions/runners --jq '[.runners[]|select(.busy)]|length'`.
  실측(2026-08-27 `cpu` 8→4): 러너가 GitHub 에 `online` 으로 돌아오기까지 **약 1분**,
  사람 개입 0(VM=launchd KeepAlive → VM 안 systemd `enabled` 두 겹이 자동 복구).
  재기동 뒤 확인 3종: `colima ssh -- nproc`(새 값) · `docker context ls` 의 `*` 가
  `desktop-linux`(autoActivate 회귀 점검) · 러너 2개 `online`.
- **잡이 안 잡힐 때(러너는 online):** 레포 변수 `PREFLIGHT_RUNNER` 가 비어 있으면
  워크플로가 GitHub 러너로 가는 것이 정상이다 — 폴백 상태인지 먼저 확인한다(P6).
- ⛔ VM·러너에서 레포 `.env` 를 source 해 빌드·스크립트를 돌리지 말 것 — 프로덕션
  DB 직결이다(P0). 잡 환경은 워크플로 파일이 전부 준다.

## 왜 앱은 컨테이너가 아닌가

이전 시도(`infra/selfhost/Dockerfile` 등, 이번에 삭제)는 두 가지 이유로
폐기했다:

1. 이 앱의 `next build` 는 빌드 타임에 실제 DB 를 읽는다 — 빌드는 DB 에
   접근 가능한 호스트에서 실행해야 한다.
2. 이 레포는 네이티브 컴파일 의존성(`bcrypt`, `better-sqlite3`, Prisma
   쿼리 엔진)을 갖고 있다 — macOS 에서 만든 `.next/standalone` 안에는
   darwin 바이너리가 들어가므로 Linux 컨테이너 안에서 실행할 수 없다.

따라서 **빌드도 호스트, 실행도 호스트**다.

## 운영 체크아웃 경로 규약

프로덕션 체크아웃은 항상 **`~/selfhost/wagcrm`**(이 iMac 기준
`/Users/z9/selfhost/wagcrm`)에 고정한다. 개발용 git worktree 와는 반드시
분리한다 — worktree 는 메인 레포와 `node_modules` 를 공유하므로, 배포
스크립트가 worktree 안에서 `npm ci`/`npm run build` 를 돌리면 진행 중인
개발 세션을 파괴한다.

launchd 는 `$HOME`/`~` 를 전개하지 않으므로 `kr.ygrd.wagcrm.app.plist` 의
모든 경로는 **절대경로**로 박혀 있다. ⚠️ **이 경로들은 이 머신 전용이다**
(`/Users/z9/selfhost/wagcrm`, `/Users/z9/selfhost/logs`) — 다른 머신에
배포한다면 plist 의 경로를 전부 그 머신 기준으로 다시 써야 한다.

## `.env` 경고

`infra/selfhost/.env` 는 **git 미추적 파일**이며 **절대 커밋하지 않는다**
(레포 루트 `.gitignore` 의 `.env*` 패턴이 이 경로를 포함해 이미 커버한다).
이 레포는 PUBLIC 이므로 실제 DB 연결 문자열·API 키 등은 이 파일에만
두고, 커밋·PR·주석 어디에도 값 자체를 남기지 않는다. `run-app.sh` 는
이 파일이 존재해야 기동한다 — 최초 배포 시 반드시 먼저 만들어야 한다.

### `.env` 필수 변수 계약

| 변수 | 값 | 이유 |
| --- | --- | --- |
| `DATABASE_URL` | 로컬 Supabase (`localhost`/`127.0.0.1`) | `deploy.sh` 의 `DATABASE_URL` 가드가 이 값을 검사한다(아래 "배포 절차"). |
| `VERCEL_ENV` | **정확히 `production`** | ⚠️ **필수, 임의 생략 금지.** 이 앱은 "Vercel 프로덕션인가"를
  `VERCEL_ENV === "production"` 하나로 판정하도록 짜여 있다. Vercel
  플랫폼을 벗어나면 이 변수는 아무도 주입해주지 않으므로 `.env` 가 이
  값의 **유일한 공급원**이다. 빠뜨리면 (또는 오타·`preview` 등 다른 값을
  넣으면) 아래 두 안전장치가 **동시에** 조용히 풀린다: |
| | | 1. `scripts/prisma-migrate-on-deploy.mjs`(23-28행)가 `VERCEL_ENV !== "production"` 조건으로 마이그레이션 적용을 **전부 건너뛰고 성공(exit 0)을 보고**한다 — `npm run build` 가 초록인데 스키마는 구버전에 멈춰 있다가, 다음 스키마 변경 배포 때 P2022 스키마 불일치로 전면 장애가 난다. |
| | | 2. `src/lib/agent-lane.ts`(7-9행)와 `src/lib/supabase/middleware.ts`(144-148행)의 에이전트 우회 레인 1차 조건(`VERCEL_ENV !== "production"`)이 영구히 참이 돼, `AGENT_BYPASS_TOKEN` 이 실수로라도 설정되면 2차 방어선 없이 `x-agent-key` 헤더만으로 인증을 우회하는 통로가 열린다. |
| `AGENT_BYPASS_TOKEN` | **절대 설정하지 않는다(미설정 상태 유지)** | 오너 확정: 이 레인은 셀프호스트 환경에서 쓰지 않는다. `VERCEL_ENV=production` 가드(위)가 1차 방어선이지만, 이 토큰 자체를 애초에 `.env` 에 넣지 않는 것이 방어의 전제다 — 두 조건이 모두 우연히 풀리는 상황(예: 배포 스크립트가 미래에 바뀌어 `VERCEL_ENV` 가드가 약해지는 경우)에 대비한 2차 방어선이다. |
| `TELEGRAM_BOT_TOKEN` | (값은 이 문서에 적지 않는다 — 레포 PUBLIC) | `infra/selfhost/notify.sh` 가 항목 빨강을 텔레그램으로 보낼 때 쓰는 봇 토큰. `@BotFather` 로 발급받는다(오너 몫). |
| `TELEGRAM_CHAT_ID` | (값은 이 문서에 적지 않는다 — 레포 PUBLIC) | `notify.sh` 가 위 봇으로 메시지를 보낼 수신 방 id. 봇에게 먼저 말을 건 뒤 확인한다(오너 몫). |
| `HEARTBEAT_URL` | (값은 이 문서에 적지 않는다 — 레포 PUBLIC) | `infra/selfhost/heartbeat.sh` 가 메뉴바 앱 full 폴링마다 생존 신고를 보내는 `wag-heartbeat` Worker 의 `/beat` 엔드포인트 주소. |
| `HEARTBEAT_TOKEN` | (값은 이 문서에 적지 않는다 — 레포 PUBLIC) | `heartbeat.sh` 가 `/beat` 호출에 싣는 `Authorization: Bearer` 토큰. 이 토큰이 없으면 dead-man 감시가 무력화된다(누구나 가짜 생존 신호를 넣을 수 있음) — 그래서 `heartbeat.sh` 는 토큰 없이는 아예 호출하지 않는다. |

`deploy.sh` 는 위 표의 `VERCEL_ENV` 값을 `git`/`npm`/`launchctl` 어떤
명령보다도 먼저 검사해, `production` 이 아니면 즉시 중단한다(아래 "배포
절차" 참고) — 이 변수를 빠뜨린 채 배포가 진행되는 사고를 스크립트
레벨에서도 막는다.

### ⚠️ 이 파일의 **빈 줄**은 분류돼 있어야 한다 (2026-08-26, T-063)

`.env` 에는 **이름은 있는데 값이 빈** 줄이 여럿 있다. 컷오버 때 구 플랫폼에서
설정을 내려받으며 sensitive 값이 빈 문자열로 내려온 여파다. 그중 일부는
의도적 공란이지만 **일부는 누락이고, 누락은 조용히 기능을 끈다** — 크론 래퍼
(`src/lib/system-task-status.ts`)는 핸들러가 `failed: true` 를 선언해야만
ERROR 로 적으므로, 산출물이 0이어도 시스템 레이더는 초록이다. 카카오 인제스트
분단 사고(2026-08-26)의 **두 번째 원인**이 이 형태의 공란 키였다.

- **⛔ 빈 줄을 일괄로 채우지 말 것.** 채우면 안 되는 줄이 섞여 있다(예:
  `ENCRYPTION_KEY_PREVIOUS` 는 교체 런북이 **제거를 지시**하고,
  `NAVER_CLIENT_SECRET` 은 `…_BASE64` 변형이 실제 공급원이라 채우면 두 출처가
  생긴다). 반대로 **채워도 아무 효과가 없는 줄**도 있다(앱이 읽지 않고 레포 밖
  러너만 읽는 키).
- **처분 선언의 정본은 코드다 — `scripts/selfhost-env-contract.ts`.** 키마다
  `required`(비면 배포 중단) · `degrades`(경고 1줄) · `optional`(조용히 통과) ·
  `unused-here`(값이 있으면 경고) 중 하나를 사유와 함께 선언한다. 짝으로 존재하는
  키(`…_BASE64` 변형·키 풀)는 `satisfiedBy` 로 묶여 **하나만 채워져 있으면** 통과한다.
  ⛔ 여기에 표를 복제하지 말 것 — 같은 사실을 두 곳에 적으면 한쪽만 걷힌다(P6 실사고).
- **집행 지점은 `deploy.sh` 의 P0 안전장치 ⑥** 이다(`npm install` 뒤 · `npm run build`
  와 `launchctl kickstart` 앞). 걸리면 서비스는 구버전을 계속 서빙한 채 배포만 멈춘다.
  수동 확인은 `npm run env:check:selfhost` — 종료코드 0=통과 · 1=필수 공란 · 2=파일 없음.
  ⛔ 이 점검을 크론으로 옮기지 말 것: 런타임에 `process.env` 를 덮어쓰는 경로가 있어
  돌고 있는 프로세스를 보면 파일이 비어 있어도 초록이 나온다(거짓 성공).
- ⚠️ **새 키를 추가하면 선언 표에도 행을 넣는다.** 안 넣으면 점검기가 **미분류 경고**로
  표면화한다(오류가 아닌 것은 의도 — 즉시 실패하는 점검기는 통째로 무시당한다).
- **판정 근거와 키별 서술은
  `docs/private/specs/2026-08-26-selfhost-env-key-coverage-design.md`** 에 있다.
  ⛔ `required` 를 늘릴 때는 **실 `.env` 로 예행부터** 할 것 — 잘못된 한 줄이 프로덕션
  배포를 통째로 막는다.
- **새 키를 이 파일에 추가할 때**는 값을 비워 두더라도 위 문서의 분류표에 행을
  함께 추가한다. 스냅샷으로 한 번 훑는 점검은 한 번만 맞다(P6
  `New Table ⇒ New RLS` 와 같은 규약).
- ⛔ 값·값의 일부를 커밋·PR 본문·주석·이 README 어디에도 적지 않는다(P0). 다룰
  수 있는 것은 **키 이름**과 **「비었는가 아닌가」**뿐이다.

## launchd/cron 이 실행하는 스크립트는 PATH 를 직접 해결해야 한다

launchd GUI 에이전트와 macOS `cron` 은 인터랙티브 셸이 아니다 — 기본 PATH 가
`/usr/bin:/bin:/usr/sbin:/sbin` 뿐이라 Homebrew 로 설치한 바이너리
(`/usr/local/bin`, Apple Silicon 은 `/opt/homebrew/bin`)가 전혀 보이지
않는다. 이 클래스의 버그는 **이미 두 번** 나왔다 — 1차는 `run-app.sh` 의
`node`(Task 2, 실측·수정 완료), 2차는 `backup.sh`/`restore-drill.sh` 의
`rclone`·`docker`(Task 5 이후, 첫 실제 launchd 예약 실행이
`[backup] 중단: rclone 이 설치돼 있지 않습니다`로 즉시 실패해 실측). 둘 다
"스크립트 안에서 잘 동작했으니 launchd 에서도 될 것"이라는 가정에서
나왔다 — dev 셸에서 수동 실행하면 셸의 PATH 를 그대로 물려받아 문제가
전혀 드러나지 않기 때문이다.

**이 프로젝트에서 launchd/cron 이 직접 실행하는 스크립트:**

| 스크립트 | 트리거 | 외부(비-시스템 경로) 바이너리 | PATH 방어 |
| --- | --- | --- | --- |
| `run-app.sh` | launchd (`kr.ygrd.wagcrm.app.plist`) | `node` | O (Task 2) |
| `backup.sh` | launchd (`kr.ygrd.wagcrm.backup.plist`) | `rclone`, `docker` | O (본 수정) |
| `backup-weekly.sh` | launchd (`kr.ygrd.wagcrm.backup-weekly.plist`) | `rclone`, `docker` | O (Phase 4) |
| `run-cron.sh` | cron (`infra/selfhost/crontab`) | 없음(`curl`/`date`/`mkdir` 전부 `/usr/bin`·`/bin`) | 불필요 |
| `restore-drill.sh` | 현재는 수동 실행만(예약 없음) | `rclone`, `docker`, `jq` | O (선제 조치 — 예약 실행으로 옮겨질 가능성 대비, 본 수정) |
| `preview-db.sh` | `preview.sh up` 이 호출(예약 없음) | `rclone`, `docker`, **`psql`** | O (프리뷰 레인). ⚠️ macOS 의 `psql` 은 brew **keg-only** libpq 라 어떤 셸 PATH 에도 없다 — 후보에 `/usr/local/opt/libpq/bin`·`/opt/homebrew/opt/libpq/bin` 를 반드시 포함한다. 누락 시 가드가 이름을 대며 중단한다(`scripts/__tests__/preview-db.test.ts` 가 고정) |

cloudflared 터널은 스크립트가 아니라 바이너리를 launchd 가 직접 exec 하므로
(plist 의 `ProgramArguments`) 이 표에는 없다 — 다만 그 바이너리 경로도
plist 에 절대경로로 박혀 있어야 같은 문제를 피한다(설치 시 확인할 것).

**새 launchd/cron 스크립트를 추가할 때 지킬 것:** 스크립트가 시스템 기본
경로(`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`) 밖에 있는 바이너리를 하나라도
호출한다면, 스크립트 맨 앞에서 `export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"`
로 후보 경로를 직접 추가하고, 그 바이너리가 실제로 없을 때는
`command -v` 로 검사해 어떤 바이너리를 어떤 PATH 에서 찾다 못 찾았는지
**이름과 PATH 값을 그대로 담아** nonzero exit 로 실패한다(`backup.sh`/
`restore-drill.sh` 상단 참고). 조용히 넘어가거나(fallback 없이 계속 진행)
"셸에서 되니까 launchd 에서도 되겠지"라고 가정하지 말 것 — 이게 이 버그가
두 번 반복된 이유다. 이 표가 세 번째 재발을 막는 것이 목적이므로, 새
launchd/cron 스크립트를 추가하면 이 표에도 행을 추가한다.

## 최초 기동 순서

⚠️ **0단계(선행, 1회만): Docker Desktop 최초 승인.** Homebrew Cask 로 설치한
Docker Desktop 은 macOS Gatekeeper 가 격리(quarantine)한다. 재부팅 시
로그인 항목 자동 기동이 "인터넷에서 다운로드한 앱을 여시겠습니까?" 대화상자에
막혀 Docker 가 뜨지 않고, Docker 에 의존하는 전체 Supabase 스택(따라서 DB
전체)이 **아무 에러 로그도 없이** 조용히 내려간 채로 남는다(위 "deploy.sh
DB 연결 확인" 이 이런 상황을 배포 시점에 잡아내는 이유이기도 하다). **실측:**
1차 무인 재부팅 리허설이 정확히 이 지점에서 실패했고, 사람이 대화상자에서
Open 을 1회 클릭해 승인한 뒤 2차 리허설은 1분 이내에 전 레이어(Docker →
Supabase 11개 컨테이너 → 앱 → 터널)가 대화상자 없이 자동 복구됐다. **이
승인은 머신당 1회**다 — 무인 재부팅 복구를 신뢰하려면, 리허설 이전에 사람이
한 번 Docker Desktop 을 수동 실행해 그 대화상자를 통과시켜 둬야 한다(아래
"무인 복구 리허설은 반드시 2회 돌린다" 참고).

1. `~/selfhost/wagcrm` 에 레포를 클론(또는 배포 스크립트로 체크아웃)한다.
2. `infra/selfhost/.env` 를 실제 값으로 채워 만든다(커밋 금지).
3. `BUILD_STANDALONE=1` 로 호스트에서 `next build` 를 실행해
   `.next/standalone/server.js` 를 만든다(DB 접근이 되는 이 호스트에서만
   가능 — 위 "왜 앱은 컨테이너가 아닌가" 참고).
   ⚠️ **`output: "standalone"` 은 `.next/static/` 과 `public/` 을 산출물에
   포함하지 않는다.** 이 두 디렉터리를 복사해 넣지 않으면 서비스는
   HTTP 로 응답은 하지만 스타일시트·클라이언트 JS 청크·정적 자산이 전부
   404 나 화면이 스타일 없이(unstyled) 뜨고 상호작용도 안 된다. 빌드
   직후 반드시 아래 두 명령을 실행한다:
   ```bash
   cp -r .next/static .next/standalone/.next/static
   cp -r public .next/standalone/public
   ```
   이 복사는 **정기 배포 경로인 `infra/selfhost/deploy.sh`(아래 "배포
   절차" 참고)가 자동으로 수행한다.** 위 두 명령은 그 스크립트를 아직
   쓸 수 없는 **최초 부트스트랩에서만 수동으로** 해야 하는 절차다.

   ℹ️ **부트스트랩 단계에서는 아직 서빙 트리(`.live`)가 없다.** `run-app.sh` 는
   `.live/current/server.js` 를 먼저 찾고, 없으면 경고 한 줄을 남긴 뒤 여기서 만든
   `.next/standalone/server.js` 로 폴백한다 — 그래서 최초 기동은 그대로 된다.
   첫 `deploy.sh` 가 산출물을 `.live/releases/<sha>` 로 옮기고 `.live/current`
   심링크를 걸면서 정상 상태가 된다(그 뒤로 `.next/standalone` 은 존재하지 않는다).
4. `infra/selfhost/launchd/kr.ygrd.wagcrm.app.plist` 를
   `~/Library/LaunchAgents/kr.ygrd.wagcrm.app.plist` 로 복사(또는 심볼릭
   링크)한다. **같은 방식으로 터널 서비스도 등록한다:**
   `infra/selfhost/launchd/kr.ygrd.wagcrm.tunnel.plist` 를
   `~/Library/LaunchAgents/kr.ygrd.wagcrm.tunnel.plist` 로 복사(또는 심볼릭
   링크)한다. ⚠️ 이 plist 가 가리키는 `--config /Users/z9/.cloudflared/config.yml`
   은 **레포 밖** 파일이다 — 실제 터널 ID·크리덴셜 파일 경로가 들어간 운영
   설정이며 커밋되지 않는다. 레포에 있는
   `infra/selfhost/cloudflared-config.example.yml` 은 그 구조를 보여주는
   자리표시자 템플릿일 뿐 이 plist 는 그 example 파일을 읽지 않는다 —
   `~/.cloudflared/config.yml` 을 실값으로 직접 만들어야 한다.
5. **`mkdir -p ~/selfhost/logs` 를 반드시 `launchctl load` 전에 실행한다.**
   launchd 는 `StandardOutPath`/`StandardErrorPath` 의 상위 디렉터리를
   만들어주지 않는다 — 이 디렉터리가 없으면 launchd 가 로그 파일을 열지
   못해 스폰이 실패하고, `KeepAlive` 때문에 `ThrottleInterval`(기본 10초)
   간격으로 **조용히** 재시도만 반복한다(정작 원인을 설명해줄 로그 파일 자체가
   못 열려서 조용한 것). `run-app.sh` 안에도 같은 `mkdir -p` 가 있지만
   그건 스크립트가 실행된 "이후"에나 동작한다 — launchd 는 스크립트를
   exec 하기 전에 이미 로그 파일을 열려고 시도하므로, 최초 부팅 실패를
   막는 것은 **이 단계**뿐이다. 이 단계를 "스크립트에 있으니 중복"이라
   여겨 지우지 말 것. 이 디렉터리 하나를 앱·터널 로그가 공유하므로 터널을
   위해 별도로 만들 디렉터리는 없다.
6. `launchctl load ~/Library/LaunchAgents/kr.ygrd.wagcrm.app.plist` 와
   `launchctl load ~/Library/LaunchAgents/kr.ygrd.wagcrm.tunnel.plist` 로
   두 서비스를 등록한다(`RunAtLoad`+`KeepAlive` 이므로 이후 재부팅·크래시
   시 자동 기동/재기동된다).
7. `curl http://127.0.0.1:3000` 으로 앱 응답을, 터널 도메인(`https://crm.ygrd.kr/`)
   으로 외부 경유 응답을 확인한다.
8. 재시작이 필요하면
   `launchctl kickstart -k "gui/$(id -u)/kr.ygrd.wagcrm.app"`
   (Task 4 `deploy.sh` 가 이 명령을 사용한다). 터널만 재시작하려면 동일하게
   `launchctl kickstart -k "gui/$(id -u)/kr.ygrd.wagcrm.tunnel"`.

⚠️ 이 문서 작성 시점(Task 2)에는 아직 빌드 산출물도 Supabase 스택도 없다
— 위 순서는 **정적 검증만 마친 상태**이고 실제 `launchctl load`/기동은
수행하지 않았다.

## 앱 크론 (Task 3)

`vercel.json` 의 `crons` 를 macOS `crontab` 으로 이식한 파일이
`infra/selfhost/crontab` 이다(이식 이후 합류한 잡도 그 파일이 정본이다 —
`capture-stories` 는 오너 맥 launchd 에서 2026-08-19 에 이 레인으로 들어왔다).
⛔ **개수를 이 제목이나 본문에 적지 말 것** — 종전 "현재 16개"는 크론이 늘 때마다
낡았다. 세야 하면 아래 판정식으로 파일에서 센다. 실행은 `run-cron.sh <job-name>` 래퍼를
거친다 — macOS cron 은 `.env` 를 읽지 않으므로, 이 래퍼가
`infra/selfhost/.env` 를 직접 source 해 `CRON_SECRET` 을 확보하고
`Authorization: Bearer` 헤더로 `/api/cron/<job-name>` 을 호출한다(인증
계약은 `src/lib/cron-auth.ts` — 시크릿 미설정 시 fail-closed 로 401).
결과는 `~/selfhost/logs/cron.log` 에 실행 1회당 한 줄로 남는다. 라벨은 넷이다:

| 라벨 | 뜻 | 시스템 레이더 | 기록량 |
| --- | --- | --- | --- |
| `OK` | 정상 | 초록 | 200자 |
| `PART` | 일부 항목이 실패했다(전체는 성공) | **초록** | 4,000자 |
| `WARN` | 앱이 이번 실행을 통째로 실패로 선언했다 | 빨강 | 4,000자 |
| `FAIL` | 호출 자체가 실패했다(종료코드 1) | — | 4,000자 |

- **알람만 보려면** `grep -E ' (WARN|FAIL) ' cron.log`
- **원인을 적어 둔 줄을 전부 보려면** `grep -E ' (PART|WARN|FAIL) ' cron.log`

⚠️ **`PART` 를 알람으로 읽지 말 것.** 개별 항목 실패는 앱이 **의도적으로** ERROR 로
올리지 않는다(`src/lib/system-task-status.ts` — "상시 노이즈까지 빨강이 되면 습관화로
신호를 잃는다"). `capture-stories` 는 **대상 전원이 실패했을 때만** 실패를 선언한다
(`declareStoryCaptureOutcome`). 그래서 라벨은 레이더와 같은 기준으로 붙이고,
`PART` 는 "나중에 왜 빠졌는지 묻게 될 줄"이라는 뜻으로만 길게 남긴다.

⚠️ **`OK` 줄만 짧게 잘린다.** 원인 특정이 필요한 세 줄은 상한이 4,000자이고, 그마저
넘으면 **잘린 사실과 잘린 양이 줄 끝에 명시된다**(무언의 말줄임 없음). 배경: 종전에는
성공·실패를 가리지 않고 잘라, 스토리 수집 잡이 전원 실패한 날 그 사유가 상한에서
끊겨 **로그만으로는 원인을 특정할 수 없었다**(2026-08-29). 전문이 남는 곳은
`SystemTaskLog.details` 하나뿐이다. 상한은 `CRON_LOG_SUMMARY_MAX` ·
`CRON_LOG_DETAIL_MAX` 로 덮을 수 있다.

🪤 **`WARN`·`PART` 는 종료코드 0 이다** — 잡 성패의 SSOT 는 이 래퍼가 아니라
`SystemTaskStatus`(시스템 레이더)다. 래퍼가 같은 사실을 한 번 더 판정하게 만들지 말 것.

🪤 **한글 절단은 로케일이 정한다.** cron 은 `LANG` 을 물려주지 않아 `LC_CTYPE=C` 로
떨어지고, 그러면 bash 가 문자가 아니라 **바이트**를 세어 절단 지점의 한글이 깨진다
(2026-08-29 실측). 래퍼가 `clip()` 안에서만 `LC_ALL=C.UTF-8`(덮어쓰기는
`CRON_LOG_LOCALE`)을 잡고, 그 로케일이 없는 호스트에서는 **설정이 조용히 실패**하므로
끝의 불완전한 UTF-8 시퀀스를 따로 걷어낸다. 두 경로 다 계약 테스트가 고정한다.

판정 계약은 `scripts/__tests__/run-cron-logging.test.ts` — 원본 스크립트를 스텁 `curl`
과 함께 **실제로 실행**한다(앵커 스캔이 아니다).

⛔ **종전 서술 "전 15줄이 주석 처리된 상태로 커밋돼 있다 … 설치하지 않는다"는
SUPERSEDED**(2026-08-13 컷오버 완료). 지금은 전 줄이 활성 상태로 커밋되며, 이중 발화
위험은 구 배포 크론이 꺼져 있는 한 없다(되살릴 때의 순서는 `crontab` 파일 상단 ✅ 블록).
⚠️ 그 서술을 믿고 **"설치해도 아무것도 안 돈다"고 판단하지 말 것** — 지금 설치하면 곧바로
실제 외부 부수효과(발주 메일·네이버 동기화 등)를 내는 잡이 돈다.

**⚠️ 크론이 추가·변경된 PR 을 pull 한 뒤에는 이 기계에서 crontab 을 재설치해야 한다.**
`deploy.sh` 는 crontab 을 건드리지 않는다 — 레포 파일이 바뀌어도 설치본은 그대로다.

```bash
cd ~/selfhost/wagcrm && crontab infra/selfhost/crontab && crontab -l | grep -cE '^[0-9*].*run-cron\.sh'
```

🪤 **앵커(`^[0-9*]`)를 빼고 `grep -c run-cron.sh` 로 세지 말 것 — 이 파일의 주석도
`run-cron.sh` 를 언급하므로 활성 잡보다 큰 수가 나온다**(2026-08-13 실측: 그때는 주석이
3줄이라 잡 15개인 상태에서 18 이 찍혀 오너가 개수 불일치로 오독했다). ⚠️ 그 **차이도**
고정값이 아니다 — 주석이 늘거나 줄면 함께 변한다(프리뷰 줄 제거로 실제로 줄었다).
"몇 큰 수"로 외우지 말고 앵커를 붙일 것. 판정식은 `cutover.sh` 의
`expected_cron_count`·`installed_cron_count` 와 **같은 정규식**이어야 한다.

설치본의 수는 레포 파일의 수와 같아야 한다:

```bash
grep -cE '^[0-9*].*run-cron\.sh' ~/selfhost/wagcrm/infra/selfhost/crontab
```

두 숫자가 같으면 설치 성공이다(고정 숫자로 판정하지 말 것 — 크론은 계속 늘어난다.
`cutover.sh` 의 검증도 같은 방식으로 파일에서 센다).

### UTC → KST 환산표

macOS cron 은 로컬 시간대(KST, UTC+9)로 돈다. `vercel.json` 의 크론
표현식은 UTC 이므로 그대로 옮기면 9시간 어긋난다. 아래는 전부를
+9h 환산한 표다(자정을 넘는 잡은 요일 필드가 원본부터 `*` 라 별도 요일
보정이 필요 없다 — 유일하게 요일이 고정된 `refresh-instagram-token` 은
자정을 넘지 않아 요일도 그대로 월요일이다).

| job | UTC (vercel.json) | KST (crontab) |
| --- | --- | --- |
| refresh-instagram-token | `0 2 * * 1` | `0 11 * * 1` |
| collect-instagram | `0 3 * * *` | `0 12 * * *` |
| collect-youtube | `0 3 * * *` | `0 12 * * *` |
| price-monitoring | `0 4 * * *` | `0 13 * * *` |
| collect-campaign-posts | `0 15 * * *` | `0 0 * * *` |
| enrich-inbox | `0 18 * * *` | `0 3 * * *` |
| rehost-seller-media | `0 20 * * *` | `0 5 * * *` |
| naver-settlement-sync | `30 21 * * *` | `30 6 * * *` |
| naver-order-sync | `0 22 * * *` | `0 7 * * *` |
| enrich-references | `30 22 * * *` | `30 7 * * *` |
| collect-qnas | `0 23 * * *` | `0 8 * * *` |
| analyze-voc | `30 23 * * *` | `30 8 * * *` |
| db-exposure-audit | `0 17 * * *` | `0 2 * * *` |
| encryption-key-audit | `30 17 * * *` | `30 2 * * *` |
| recampaign-auto-propose | `0 0 * * *` | `0 9 * * *` |
| tax-invoice-issue-confirm | `0 1 * * *` | `0 10 * * *` |

## Agent Worker (launchd, 계보 [HHostWAG] Task 7)

⚠️ **이 세션(Task 7 구현자)은 아래 어떤 명령도 실행하지 않았다** —
`infra/selfhost/run-agent-worker.sh`·
`infra/selfhost/launchd/kr.ygrd.wagcrm.agent-worker.plist` 를 새로 만들고
`bash -n`/`plutil -lint`/유닛 테스트로만 정적 검증했다. `launchctl
bootstrap`·워커 기동·`~/selfhost` 실환경 조작은 전혀 하지 않았다. 아래
순서는 설치 패킷(`task-8-install-packet.md` §A-2~A-3)과 대조하는
체크리스트로 쓴다 — 실제 실행 결과는 그 문서·Task 9 소관이다.

Hermes 가 WAG 도메인 작업(딜 조회 등)을 처리하도록 맡기는 별도 상주
프로세스다. 앱(`kr.ygrd.wagcrm.app`)과 **완전히 분리된 launchd 서비스**이고,
DB 접속도 최소권한 역할(`wag_agent_worker`)로 앱과 분리된다 — 두 접속
문자열이 섞이면 워커가 조용히 전체 권한을 갖게 되므로(아래 참고), 절대
`infra/selfhost/.env`(앱 크리덴셜)를 워커에 재사용하지 않는다.

### 최초 기동 순서

1. **워커 전용 env 파일을 새로 만든다** — `infra/selfhost/agent-worker.env`
   (git 미추적, `.gitignore` 가 명시적으로 커버). 앱 `.env` 를 복사하지
   말고, `DATABASE_URL` 하나만 **워커 role(`wag_agent_worker`) 접속
   문자열**로 채운다. 이 role 생성은 오너 전용 수동 단계다(설치 패킷
   §A-2-1) — 저장소 어디에도 이 role 을 만드는 코드가 없다:
   ```sql
   CREATE ROLE wag_agent_worker LOGIN PASSWORD '<오너-발급-비밀번호>';
   ```
   `run-agent-worker.sh` 는 이 파일의 `DATABASE_URL` 이 앱 `.env` 의
   `DATABASE_URL` 과 같으면(값은 출력하지 않고 비교만 해서) 기동을 거부한다
   — 두 값이 같다는 것은 role 을 분리하지 않았다는 신호이기 때문이다.
2. **네이티브 addon 을 빌드한다**(레포 루트에서):
   ```bash
   npm run agent-worker:build-native
   ```
   `src/lib/agent-worker/native/peer-cred/build/Release/peer_cred.node` 가
   없으면 래퍼가 정확한 빌드 명령을 담은 한글 오류로 기동을 거부한다.
3. `mkdir -p ~/selfhost/logs` — 앱과 같은 로그 디렉터리를 공유한다(이미
   앱을 설치했다면 보통 이미 존재한다).
4. `infra/selfhost/launchd/kr.ygrd.wagcrm.agent-worker.plist` 를
   `~/Library/LaunchAgents/kr.ygrd.wagcrm.agent-worker.plist` 로 복사(또는
   심볼릭 링크)한다.
5. ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/kr.ygrd.wagcrm.agent-worker.plist
   ```
   (구 `launchctl load` 대신 `bootstrap` — 이 문서의 다른 서비스들도 같은
   경로를 쓴다.)

### 상태 확인

```bash
launchctl print gui/$(id -u)/kr.ygrd.wagcrm.agent-worker | grep state
tail -n 50 ~/selfhost/logs/agent-worker.out.log
```
`state = running` 이고 로그에 `"event":"started"` JSON 줄이 보이면 정상이다.
워커는 HTTP 를 열지 않는다 — 로컬 유닉스 도메인 소켓(UDS) RPC 로만
응답한다(소켓 경로는 `scripts/agent-worker.ts` 참고, 기본값은 코드가
결정한다). 소켓 파일이 보이지 않으면 위 로그에서 `startup_failed` 를 먼저
찾는다.

### 재시작 / 중지

```bash
launchctl kickstart -k "gui/$(id -u)/kr.ygrd.wagcrm.agent-worker"   # 재시작
launchctl bootout "gui/$(id -u)/kr.ygrd.wagcrm.agent-worker"        # 완전 중지(등록 해제)
```
⚠️ **배포는 이 재시작을 자동으로 한다** — `deploy.sh` 가 DB 프로브 뒤 마커 기록 앞에서
워커를 `kickstart` 하고 PID 교체까지 확인한다(프로덕션 레인 한정). 위 명령은 배포와
무관하게 손으로 재시작할 때만 쓴다.
🪤 **왜 자동화했나(2026-09-06 실사고):** 앱은 `.live/current` 릴리스를 서빙하지만 워커는
이 체크아웃을 tsx 로 직접 읽는다. 그래서 배포가 성공하고 마커가 갱신되고 파일도 제자리에
있는데 **워커만 옛 코드로 계속 도는** 상태가 생겼다(PR #36, 워커가 3일 전 기동분 그대로).
겉으로 드러나는 신호가 없어 프로세스 기동 시각을 직접 재야만 알 수 있었다.
워커는 `SIGTERM` 을 받으면 자신이 쥔 lease 만 정리하고 종료한다
(`scripts/agent-worker.ts` shutdown 경로) — plist 의 `ExitTimeOut` 30 초는
그 정리 시간을 보장하기 위한 값이다.

### 소켓 경로 메모

이 워커는 앱과 달리 포트를 열지 않고 로컬 UDS 하나로만 통신한다. 소켓
경로를 명시적으로 지정하려면 `agent-worker.env` 에
`WAG_AGENT_WORKER_SOCKET` 을 추가하면 되지만(선택), **값은 이 문서에도,
어떤 커밋에도 적지 않는다** — 이 레포는 PUBLIC 이고 소켓 경로 자체는
민감정보가 아니지만 관례상 운영 좌표는 `agent-worker.env`(미추적)에만
둔다. 네이티브 addon 경로 오버라이드(`WAG_AGENT_WORKER_PEER_CRED_ADDON`)도
같은 파일에 둔다 — `WorkingDirectory` 가 레포 루트(`~/selfhost/wagcrm`)면
기본값(상대경로 해석)으로 충분하다.

## 배포 절차 (Task 4)

정기 배포는 **운영 체크아웃(`~/selfhost/wagcrm`)에서만**
`./infra/selfhost/deploy.sh` 한 줄로 수행한다. 이 스크립트는
`origin/release` 최신화 → 호스트 빌드(`BUILD_STANDALONE=1 npm run
build`, ⚠️ 이 빌드 안에서 마이그레이션이 실제로 적용되는 것은
`VERCEL_ENV=production` 이 `.env` 에 설정돼 있기 때문이다 — 아래 가드와
위 ".env 필수 변수 계약" 참고. 이 변수가 없으면 `prisma-migrate-on-deploy`
가 조용히 스스로를 건너뛰고 성공을 보고하므로 빌드는 초록인데 마이그레이션은
전혀 적용되지 않는다) → `.next/standalone` 에 `public`/`.next/static` 배치
→ **완성된 산출물을 `.live/releases/<sha>` 로 옮기고 `.live/current` 심링크 교체**
(2026-08-29 안전장치 ⑧ — 빌드가 서빙 중인 트리를 덮어쓰지 않게 한다)
→ `launchctl kickstart` 재시작 → **새 프로세스가 릴리스 경로로 떴는지 확인**
→ `127.0.0.1:3000` 헬스체크 → DB 프로브 → **Agent Worker 재기동(PID 교체 확인)**
→ 배포 마커 기록 → 오래된 릴리스 정리까지
한 번에 끝낸다. 기존 promote 레인(main → release)은 그대로 두고, **release 를
소비하는 쪽만** Vercel 에서 이 스크립트로 바뀐다.

스크립트 맨 앞에 세 가지 안전장치가 있고, 각각 `git`/`npm`/`launchctl`
명령보다 먼저 실행돼 조건에 걸리면 그 이전에 즉시 종료(exit 1)한다:

- **`VERCEL_ENV` 가드:** `.env` 를 소싱한 직후, `VERCEL_ENV` 가 정확히
  `production` 인지 본다. 아니면(미설정·오타·`preview` 등) 중단한다.
  `scripts/prisma-migrate-on-deploy.mjs` 가 이 값 하나로 마이그레이션
  적용 여부를 판정하기 때문에, 이 가드가 없으면 빌드가 "성공"했다고
  보고하면서 실제로는 스키마를 전혀 갱신하지 않는 상태로 서비스가
  재시작돼버린다(다음 스키마 변경 때 P2022 전면 장애). 위 ".env 필수
  변수 계약" 참고.
- **`DATABASE_URL` 가드:** `infra/selfhost/.env` 를 읽어 URL 에서 host
  부분만 정확히 추출(scheme 제거 → 자격증명 제거 → `:`/`/` 에서 절단)해
  `localhost`/`127.0.0.1` 과 **정확히 일치**하는지 본다. 부분일치(substring)
  가 아니다 — 비밀번호나 쿼리스트링에 우연히 "localhost"/"127.0.0.1" 이라는
  글자가 섞여 있어도 host 자체가 다르면 중단한다. **이 가드가 검사하는 값은
  `infra/selfhost/.env` 의 `DATABASE_URL`** 이고, 스크립트 맨 앞의 `set -a` 가
  그 값을 export 해 `npm run build` 까지 그대로 내려간다. 그래서 그 값이 로컬이
  아니면 빌드 안의 `prisma-migrate-on-deploy` 가 (`VERCEL_ENV=production` 가드까지
  통과한 상태라면) **원격 DB 에 마이그레이션을 적용해버린다** — 구체적으로는
  컷오버 때 Vercel 에서 옮겨 적은 연결 문자열이 남거나 되돌아오는 경우(은퇴한
  클라우드 Supabase 프로젝트 · 외부 스테이징 · 장래의 관리형 DB)다.
  ⛔ 종전 근거 「레포 개발용 `.env` 는 프로덕션 Supabase 를 가리키므로(P0)」는
  **SUPERSEDED**(2026-08-13 셀프호스트 컷오버 · 2026-08-26 실측) — 지금은 레포
  `.env` 도 host 가 `127.0.0.1` 이라 **이 host 비교로는 두 파일이 갈리지 않는다.**
  레포 `.env` 로 잘못 도는 경로를 막는 것은 이 가드가 아니라 **읽는 파일이
  `infra/selfhost/.env` 로 고정돼 있다는 사실** 쪽이다. 두 방어는 막는 대상이
  다르므로 어느 쪽도 걷지 않는다. (레포 `.env` 가 프로덕션 DB 라는 사실 자체는
  그대로다 — AGENTS.md P0 「Repo .env Is Production DB」.)
- **워크트리 가드:** 현재 경로에 `/.claude/worktrees/` 가 포함되면
  중단한다. 개발 워크트리는 메인 레포와 `node_modules` 를 공유하므로,
  여기서 `npm install`/`npm run build` 를 돌리면 진행 중인 다른 세션을
  망가뜨린다.

### 배포 완료 마커 (`~/selfhost/logs/deployed.sha`)

"이미 배포됨" 판정은 `git` 상태(`HEAD`)가 아니라 이 마커 파일과
`origin/release` 를 비교해서 내린다. 이유: 스크립트는 빌드 전에 먼저
`git reset --hard origin/release` 로 체크아웃을 최신화한다 — 만약 그
다음 빌드가 실패하면, 체크아웃은 이미 새 커밋인데 서비스는 여전히 구
버전을 서빙 중인 상태가 된다. 이때 `HEAD` 기준으로 "변경 없음"을
판정하면 다음 실행이 아무 것도 안 하고 조용히 exit 0 해버려 재배포
시도조차 안 하게 된다. 그래서 헬스체크까지 **완전히 성공했을 때만**
`~/selfhost/logs/deployed.sha` 에 배포된 sha 를 기록하고, 다음 실행은
`origin/release` 를 그 파일과 비교한다 — 빌드 실패 후 재실행은
`FORCE=1` 없이도 정상적으로 재시도된다. 마커는 체크아웃(레포 트리) 밖
`~/selfhost/logs/` 에 두므로 `git reset --hard` 로 지워지지 않는다.

`origin/release` 가 마커와 같으면 스크립트는 아무 것도 하지 않고
종료한다(exit 0) — 강제로 다시 배포하려면 `FORCE=1
./infra/selfhost/deploy.sh` 를 쓴다.

### 재시작 검증 (PID + 헬스체크)

`launchctl kickstart` 가 조용히 실패해도 구 프로세스가 계속
`127.0.0.1:3000` 에 응답할 수 있어 HTTP 헬스체크만으로는 "새 프로세스가
떴다"를 증명하지 못한다. 그래서 kickstart 전후로 `launchctl list
kr.ygrd.wagcrm.app` 에서 PID 를 읽어 **PID 가 실제로 바뀌었는지**까지
확인한 뒤에야 HTTP 헬스체크로 넘어간다(PID 교체 = 재시작됨, HTTP 200 =
정상 기동됨 — 둘 다 필요). kickstart 명령 자체의 종료 상태도 확인한다.
PID 가 안 바뀌면 그 자리에서 exit 1.

헬스체크가 30회(약 2분 30초) 동안 실패하면 스크립트는 exit 1 로 끝나며,
원인 확인은 `~/selfhost/logs/app.err.log` (launchd 가 기록하는 앱
표준에러)를 본다.

### DB 연결 확인 (Phase 2 리허설 후속)

HTTP 헬스체크 통과 = 앱 프로세스가 응답 중이라는 뜻일 뿐, **DB 가 살아있다는
뜻이 아니다.** 실측: Supabase 컨테이너 전체(0개 기동)가 내려간 상태에서도
`https://crm-test.ygrd.kr/` 는 HTTP 200 을 반환했다 — 미인증 요청을
`/login` 으로 리다이렉트하고 그 화면 자체가 DB 접근 없이 렌더링되기
때문이다. 그래서 `deploy.sh` 는 HTTP 헬스체크 다음, 마커 파일을 쓰기 전에
**별도로** DB 연결을 확인한다: 앱의 `DATABASE_URL` 로 별도 `node` 프로세스가
Prisma `$queryRaw\`SELECT 1\`` 를 실행한다(애플리케이션 테이블은 조회하지
않는다). 새 공용 헬스 엔드포인트를 추가하지 않은 이유는 위 "왜 앱은
컨테이너가 아닌가" 절 규모의 판단이다 — 인터넷에 노출된 CRM에 인증 없는
DB 프로브 경로를 여는 비용이 배포 편의보다 크다. 이 프로브는 별도
프로세스/커넥션이므로 "이 연결 문자열로 DB 에 지금 붙을 수 있다"만
증명하고, 방금 재시작된 앱 프로세스 자신이 활성 DB 커넥션을 물고 있는지는
증명하지 못한다 — 그건 앱 프로세스 내부 커넥션 풀의 별개 계층이다. 실패
시 `docker ps` 로 Supabase 컨테이너 상태부터 확인한다.

### 메뉴바 「배포하기」 (2026-08-14)

정기 배포는 메뉴바 패널의 **배포하기** 버튼으로도 할 수 있다. 버튼은
`infra/selfhost/release-deploy.sh` 를 부르고, 그 스크립트가
①`deploy.sh`(CRM) → ②`ygrd-link/` 가 실제로 바뀐 경우에만 `wrangler deploy`
순서로 돌린다. 체크아웃 경로는 스크립트가 하드코딩해 소유하므로 어느
디렉터리에서 실행하든 대상이 바뀌지 않는다. 예행은 `--dry-run`.
링크 서버 배포 기록은 `~/selfhost/logs/deployed.ygrd-link.sha` 다.
⚠️ **Swift 앱 자신이 바뀐 회차만은 `install-menubar.sh` 가 따로 필요하다**
(버튼으로는 앱을 갱신할 수 없다).

## cloudflared 터널 (Task 3, 서비스 등록은 Task 2 후속으로 완료)

`infra/selfhost/cloudflared-config.example.yml` 이 ingress 규칙 예시다 —
`crm.ygrd.kr` → 앱(`127.0.0.1:3000`), `sb.ygrd.kr` → Supabase
(`127.0.0.1:8000`), 마지막에 catch-all `http_status:404`(cloudflared 는
이 규칙이 없으면 기동을 거부한다). 터널 ID·크리덴셜 파일 경로는
자리표시자(`<TUNNEL-ID>`)다.

⚠️ **실제 운영 설정 파일 위치는 `~/.cloudflared/config.yml`(레포 밖)이다** —
이전 버전 이 문서는 운영 파일이 `infra/selfhost/cloudflared-config.yml`(레포
안, gitignore 로 추적 제외)이라고 적었으나 **SUPERSEDED**다. 실제 리허설에서
검증된 launchd 서비스(`infra/selfhost/launchd/kr.ygrd.wagcrm.tunnel.plist`,
위 "최초 기동 순서" 4단계에서 등록)는 `--config /Users/z9/.cloudflared/config.yml`
을 명시적으로 가리키며, 이 파일이 실제 터널 ID·크리덴셜 파일 경로를 담은
유일한 운영 사본이다. `infra/selfhost/cloudflared-config.example.yml`(레포
안, 커밋됨)은 그 구조를 보여주는 템플릿일 뿐 cloudflared 가 직접 읽는
파일이 아니다 — 새 머신에 배포할 때는 example 파일 내용을 참고해
`~/.cloudflared/config.yml` 을 실값으로 새로 만들어야 한다.

## 백업 (Task 5)

⚠️ **이 백업은 더 이상 여러 안전장치 중 하나가 아니다.** 이전 클라우드
제공자의 point-in-time-recovery 는 이관과 함께 사라졌고, 예전 GitHub
Actions 백업은 이 iMac 의 Docker Supabase 에 더 이상 접근할 수 없다.
`infra/selfhost/backup.sh` 가 **지금 이 순간 유일한 롤백 수단**이다.

### 무엇이 언제 도는가

`infra/selfhost/launchd/kr.ygrd.wagcrm.backup.plist` 가 매일 **KST
04:00**(앱 예약 잡 사이의 빈 구간 — 위 "앱 크론" 절 UTC→KST
환산표 참고)에 `backup.sh` 를 1회 실행한다. `StartCalendarInterval` 을
쓰며(주기적 1회성 작업이므로 `KeepAlive` 는 쓰지 않는다 — 실패해도
재시도 폭주 없이 다음날 예정 시각까지 기다린다), 등록은 앱/터널과 같은
방식이다:

```bash
cp infra/selfhost/launchd/kr.ygrd.wagcrm.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/kr.ygrd.wagcrm.backup.plist
```

### 왜 덤프가 2개인가

매 실행 R2(`backups/<YYYYMMDD-HHMMSS>/`)에 gzip 파일 2개를 올린다:

- **`full.sql.gz`** — `pg_dump` 전체 덤프(전 스키마). "동일한 스택"(지금과
  같은 버전의 Supabase 컨테이너 세트가 이미 떠 있는 상태) 위에 그대로
  복원하거나 포렌식(사후 조사)용이다.
- **`public-data-only.sql.gz`** — `public` 스키마의 데이터만(테이블 정의
  없음), `_prisma_migrations` 제외. **완전히 새로 만든** 스택(아직 컨테이너를
  띄운 적 없는 새 머신) 위에 복원할 때 쓴다.

새 스택에는 `full.sql.gz` 를 쓸 수 없다 — `auth`·`storage` 스키마는 이
앱이 아니라 GoTrue·Storage API 가 자체 마이그레이션으로 소유·버전 관리하고,
그 이력은 설치마다 다르다(실측: 두 스키마 모두 마이그레이션 적용 개수
자체가 어긋나 있었다 — 정확한 수치는 실측치라 커밋에 남기지 않는다, P0).
그대로 부으면 이미 다른 버전으로 존재하는 객체와 충돌해 무더기 에러가
난다(이 저장소에서 실제로 재현·확인함 — `restore-drill.sh` 가 이 경로를
쓰지 않는 이유이기도 하다). `_prisma_migrations` 를 데이터에서 뺀 이유:
아래 재구축 경로의 3번째 단계가 이미 대상 DB 기준으로 올바른 레코드를
스스로 만든다 — 원본 DB 의 레코드를 얹으면 마이그레이션 상태 자체가
오염된다. (전체 근거는 `backup.sh` 상단 주석 — 다음 사람이 "파일 하나
지워도 되나" 싶을 때 거기부터 읽을 것.)

### 용량 가드 · 보관정책

- **업로드 전 용량 가드:** `rclone size` 로 버킷 전체 현재 사용량을 재고,
  무료 티어(10GB)의 80%(8GiB) 이상이면 **업로드하지 않고** nonzero exit 로
  중단한다. 매 실행 현재 사용량을 로그에 남겨 증가 추세가 보이게 한다.
- **보관정책(30일):** 업로드·검증 성공 후 `backups/` 아래 30일 이상 지난
  객체를 `rclone delete --min-age 30d` 로 지운다. 이 토큰의 delete
  권한은 배포 전 별도로 실측 검증했다(list/upload/delete 전부 동작
  확인) — 하지만 훗날 이 권한이 조용히 막히면 백업이 무한히 쌓여 결국
  무료 티어를 넘긴다. 그래서 삭제 실패는 조용히 넘어가지 않는다:
  백업 자체는 이미 성공했어도 스크립트 전체가 nonzero exit 로 끝나고
  경고를 로그에 남긴다.

### 주간 전체 백업 (`backup-weekly.sh`, Phase 4) — 다른 벤더로

일간 백업(`backup.sh`)은 **DB 만** 백업한다. 오브젝트 스토리지 파일
(셀러가 올린 이미지 등, 이 문서 작성 시점 약 1,223 개·80MB 안팎)은
일간 백업에 전혀 포함되지 않는다 — 이관 후에는 이 iMac 이 그 파일들의
유일한 사본이라는 뜻이다. 게다가 일간 백업의 목적지(R2)는 이 배포의
터널·DNS 를 쥔 것과 **같은 벤더 계정**이다 — 그 계정에 문제가 생기면
서비스와 백업이 동시에 사라진다. `backup-weekly.sh` 는 이 두 구멍을
동시에 메운다: 목적지는 **다른 벤더**(Google Drive, rclone remote
`gdrive`, `rclone config create gdrive drive scope=drive.file` 로 인가)이고,
내용물에 DB 덤프뿐 아니라 오브젝트 스토리지 파일도 포함한다.

**무엇이 언제 도는가:** `kr.ygrd.wagcrm.backup-weekly.plist` 가 매주
**일요일 KST 22:00**(앱 예약 잡이 전혀 없는 저녁 공백 구간, 이 잡은
일간 백업보다 무거워 양쪽 이웃 잡과 거리가 먼 시각을 골랐다 — plist
주석 참고)에 1회 실행한다. 등록 방식은 다른 launchd 서비스와 동일하다:

```bash
cp infra/selfhost/launchd/kr.ygrd.wagcrm.backup-weekly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/kr.ygrd.wagcrm.backup-weekly.plist
```

**내용물(매 실행 Google Drive `wagcrm-weekly-backups/<YYYYMMDD-HHMMSS>/`
아래 3개 업로드):**

- **`full.sql.gz`** — `backup.sh` 와 동일한 방식(`pg_dump`, 전 스키마)의
  전체 DB 덤프.
- **`storage-data.tar.gz`** — Docker **네임드 볼륨** `supabase_storage-data`
  (호스트 바인드 마운트가 아니다 — macOS 가 storage 서비스에 필요한
  extended-attribute 를 지원하지 않아 바인드 마운트를 의도적으로
  포기했다)를 읽기 전용으로 일회용 컨테이너에 마운트해 타르로 묶은
  것. 실행 중인 `supabase-storage` 컨테이너는 멈추거나 건드리지 않는다.
- **`manifest.json`** — 이 백업이 **어느 Google 계정**으로 올라갔는지
  기록한 작은 JSON(`account_email`·`timestamp`·`created_at_utc`·`remote`
  경로·두 산출물의 이름과 바이트 크기). ⚠️ **이게 왜 있는가(실사고,
  이론이 아니다)**: 이 스크립트를 만들고 실제로 한 번 돌린 직후, 오너가
  rclone 을 다른 Google 계정으로 재인증했다. 그러자 방금 성공한 백업을
  조회할 때마다 `directory not found` 가 떴다 — 파일이 지워진 게 아니라
  `scope=drive.file` 특성상 rclone 이 "자신이 만든 파일"만 볼 수 있어서,
  계정이 바뀌면 이전 백업이 안 보이게 될 뿐이었다. 이 증상은 "백업이
  진짜로 사라졌다"와 겉보기에 완전히 동일하다 — 몇 달 뒤 이 iMac 이 아닌
  다른 머신에서 복구하는 사람은 이 둘을 구분할 방법이 manifest 없이는
  없다. 백업의 위치는 경로 하나가 아니라 "경로 + 어느 계정으로 인증했을
  때 보이는가"의 쌍이고, manifest 가 그 뒷반쪽을 백업 자체와 같은 곳에
  남긴다(로컬 로그는 이 iMac 이 사라지면 함께 사라지지만 manifest 는
  살아남는다). 자세한 복구 절차는 아래 "비상 복원 절차"의 0번 참고.

**왜 셋 다 있어야 복원이 되는가:** DB 덤프에는 오브젝트를 가리키는
행(경로·소유자·메타데이터)이 있고, 실제 바이트는 스토리지 타르 안에
있다. 하나만 복원하면 DB 는 존재한다고 말하는 파일이 실제로 없거나,
파일은 있는데 그 파일을 가리키는 행이 없는 상태가 된다 — DB 덤프와
스토리지 타르는 **둘 다** 필요하다. manifest 는 복원 자체에는 쓰이지
않지만, 복원을 "시도"하기 전에 지금 인증된 계정이 이 백업을 올린
계정과 같은지 확인하는 데 필요하다(그 확인 없이는 애초에 셋 다 눈에
보이지도 않을 수 있다).

**보관정책(12주):** `wagcrm-weekly-backups/` 아래 12주 이상 지난 객체를
`rclone delete --min-age 12w` 로 지운다. 일간 백업과 같은 원칙으로,
삭제 실패는 조용히 넘어가지 않는다 — 백업 자체는 성공해도 스크립트
전체가 nonzero exit 로 끝나고 경고를 로그에 남긴다. (용량 가드는 여기
없다 — `drive.file` 스코프에서는 rclone 이 자신이 만든 파일만 볼 수
있어 "이 remote 의 사용량"이 "Drive 계정 전체 잔여 용량"을 대표하지
못한다. 부정확한 가드보다 없는 편이 낫다고 판단했다 — 자세한 근거는
`backup-weekly.sh` 상단 주석. 12주 보관정책이 무한 증가를 막는 유일한
장치다.)

**로그:** `~/selfhost/logs/backup-weekly.out.log` ·
`~/selfhost/logs/backup-weekly.err.log`.

### 두 백업이 왜 다른 벤더인가 — 요약

| | 일간(`backup.sh`) | 주간(`backup-weekly.sh`) |
| --- | --- | --- |
| 목적지 | Cloudflare R2 (rclone remote `r2`) | Google Drive (rclone remote `gdrive`, `drive.file` 스코프) |
| 내용물 | `full.sql.gz` + `public-data-only.sql.gz` | `full.sql.gz` + `storage-data.tar.gz` |
| 보관정책 | 30일 | 12주 |
| 주기 | 매일 04:00 KST | 매주 일요일 22:00 KST |

R2 는 이 배포의 터널·DNS 도 쥔 벤더 계정이다 — 그 계정 하나에 문제가
생겨도 서비스와 "모든" 백업이 동시에 죽지 않으려면 최소 하나의 백업
경로는 다른 벤더에 있어야 한다. 그 역할이 주간 백업이다.

### 두 산출물을 함께 쓰는 복원 절차(주간 백업 기준)

0. **먼저 계정을 확인한다 — `directory not found` 는 백업이 없다는
   증거가 아니다.** `rclone about gdrive:` 로 rclone 이 지금 어느 remote
   설정에 묶여 있는지(연결·인증이 살아있는지) 확인한 뒤,
   `rclone lsjson gdrive:wagcrm-weekly-backups/<복원하려는 TS> -M` 로
   대상 백업을 조회해 그 안의 `manifest.json` 을 내려받아
   (`rclone cat gdrive:wagcrm-weekly-backups/<TS>/manifest.json`)
   `account_email` 필드를 확인한다 — 이 값이 지금 rclone 이 인증된
   계정과 다르면, `directory not found` 나 빈 목록이 뜨는 게 **당연한
   결과**다. 백업이 사라진 게 아니라 다른 계정으로 인증돼 있어서 안
   보이는 것뿐이다(`scope=drive.file` 스코프에서는 rclone 이 자신이
   만든 파일만 볼 수 있다). ⚠️ **이건 이론이 아니라 실측이다** — 이
   설정을 실제로 구축하던 중, 오너가 Google 계정을 바꿔 재인증한
   직후 정확히 이 증상(방금 성공한 백업이 `directory not found` 로
   보임)이 재현됐다. 올바른 계정으로 다시 인증(`rclone config reconnect
   gdrive:` 또는 `rclone config` 로 재인가)한 뒤에야 백업이 다시 보인다.
   이 단계를 건너뛰고 "백업이 없다"고 결론 내리면 실제로는 존재하는
   백업을 두고 최악의 순간에 잘못된 판단을 하게 된다.
1. 새 Supabase 스택을 기동해(GoTrue·Storage 가 각자 스키마를 스스로
   만들게 둠) `prisma migrate deploy` 로 `public` 스키마를 재구축한다
   (위 "비상 복원 절차"의 1번과 동일한 전제 — `full.sql.gz` 를 완전히
   새 스택에 그대로 붓지 않는 이유도 동일하다: `auth`/`storage` 스키마의
   자체 마이그레이션 이력이 설치마다 달라 충돌한다).
2. `full.sql.gz` 에서 `public` 스키마 데이터를 필요한 형태로 추출해
   주입한다(일간 백업의 `public-data-only.sql.gz` 와 동일한 제약이 적용
   된다 — `_prisma_migrations` 은 새로 만든 스택의 것을 써야 한다).
3. `storage-data.tar.gz` 를 새 `supabase_storage-data` 네임드 볼륨에
   되돌린다 — 예: 일회용 컨테이너로 그 볼륨을 쓰기 가능하게 마운트하고
   타르를 풀어 넣는다(`docker run --rm -v supabase_storage-data:/data
   -v <다운로드폴더>:/backup-in alpine sh -c 'tar -xzf
   /backup-in/storage-data.tar.gz -C /data'`).
4. 2·3 단계 순서는 상관없지만 **둘 다** 끝나야 애플리케이션이 정상
   동작한다 — DB 행만 있고 파일이 없으면 다운로드 링크가 깨지고, 파일만
   있고 행이 없으면 애플리케이션이 그 파일의 존재 자체를 모른다.
5. 복원 직후 `restore-drill.sh` 와 같은 방식(테이블 수·행 수 대조)으로
   재검증한다.

### 로그

`~/selfhost/logs/backup.out.log` · `~/selfhost/logs/backup.err.log`
(launchd 표준 출력/에러 — 앱/터널과 같은 관례). 리허설(아래)은 별도로
`~/selfhost/logs/restore-drill.log` 에도 누적 기록한다(수동 실행이 잦아
launchd 로그만으로는 이력을 놓치기 쉬워서).

### 복원 리허설 (`restore-drill.sh`) — 정기적으로 수동 실행할 것

"아무도 복원해본 적 없는 백업은 백업이 아니다." R2 의 최신 백업을 받아
**일회용(throwaway) 컨테이너**에 실제로 복원하고, 라이브 DB 와 테이블
수·테이블별 정확한 행 수를 대조해 pass/fail 을 nonzero exit 로 보고한다.
**라이브 `supabase-db` 컨테이너는 절대 건드리지 않는다**(읽기 전용
SELECT 로 행 수만 센다) — 이름 충돌 방지·정리 함수의 이중 확인 등 안전
설계는 스크립트 상단 주석 참고. 성공·실패 관계없이 일회용 컨테이너와
로컬 임시 파일을 항상 정리한다.

```bash
./infra/selfhost/restore-drill.sh
```

운영 체크아웃(`~/selfhost/wagcrm`, `npm install` 이 끝난 상태)에서
그대로 실행하면 된다 — `node_modules/.bin/prisma` 를 기본으로 찾는다.
(개발 워크트리처럼 `node_modules` 가 없는 곳에서 이 스크립트 자체를
검증할 때만 `PRISMA_BIN` 환경변수로 이미 설치된 다른 경로를 가리킨다 —
이 스크립트는 어떤 워크트리에서도 `npm install` 을 직접 실행하지
않는다.)

### 비상 복원 절차 (실제 장애 시)

1. **완전히 새 스택**(컨테이너 없는 새 머신 또는 전부 내린 상태)이라면:
   `docker compose up` 등으로 Supabase 컨테이너들을 기동해 GoTrue·Storage
   가 각자 스키마를 스스로 만들게 둔 뒤, 이 레포에서
   `DATABASE_URL=... DIRECT_URL=... npx prisma migrate deploy` 로 `public`
   스키마를 재구축하고, R2 의 최신 `public-data-only.sql.gz` 를 받아
   `psql -U supabase_admin -d postgres -f public-data-only.sql` 로 데이터를
   주입한다(`supabase_admin` 이유: 이 이미지에서 `postgres` 롤은
   superuser 가 아니라 `--disable-triggers` 문을 실행할 권한이 없다 —
   `restore-drill.sh` 참고).
2. **동일한 스택이 이미 떠 있는 상태**(예: 컨테이너는 살아있는데 DB 데이터만
   복구해야 하는 경우)라면 R2 의 최신 `full.sql.gz` 를 받아 그대로
   `psql -U postgres -d postgres -f full.sql` 로 복원한다.
3. 어느 경로든 복원 직후 `restore-drill.sh` 와 동일한 방식(테이블 수·행
   수 대조)으로 반드시 재검증한다 — 복원 명령이 exit 0 을 반환했다는 것과
   데이터가 실제로 온전하다는 것은 별개다.

## 무인 복구 리허설은 반드시 2회 돌린다 (Phase 2 후속)

재부팅 한 번으로 "무인 복구가 된다"고 결론 내리지 않는다. **1차 실행은
1회성 게이트(Gatekeeper 승인, 최초 실행 초기화 등)를 태우는 실행이고,
그 게이트가 이미 통과된 상태에서 도는 2차 실행만 정상 상태(steady-state)
복구를 증명한다.** 실측: 1차 리허설은 위 "Docker Desktop 최초 승인"
지점에서 실패했다 — 사람이 대화상자를 승인한 뒤 돌린 2차 리허설은 대화상자
없이 1분 이내에 전 레이어가 자동 복구됐다.

**검증 절차:**

1. Docker Desktop 최초 승인을 미리 1회 완료해 둔다(위 0단계).
2. 머신을 재부팅한다.
3. 재부팅 후 아래 명령으로 판정한다:
   ```bash
   echo "app pid: $(launchctl list kr.ygrd.wagcrm.app 2>/dev/null | awk -F'= ' '/"PID"/ { gsub(/[; ]/, "", $2); print $2 }')"
   echo "tunnel pid: $(launchctl list kr.ygrd.wagcrm.tunnel 2>/dev/null | awk -F'= ' '/"PID"/ { gsub(/[; ]/, "", $2); print $2 }')"
   # 이 스택은 `docker compose` 로 띄운다(Supabase CLI dev 스택이 아니다) —
   # 컨테이너 라벨은 `com.docker.compose.project=supabase` 다. 이름으로
   # 매칭(`--filter "name=supabase-"`)하지 말 것: 무관한 컨테이너가 이름에
   # "supabase-" 를 우연히 포함하면 같이 잡혀 개수가 부풀 수 있다 — compose
   # 프로젝트 라벨이 더 정확하다.
   echo "supabase containers: $(docker ps --filter "label=com.docker.compose.project=supabase" -q | wc -l | tr -d ' ')"
   curl -o /dev/null -s -w "tunnel http: %{http_code}\n" https://crm.ygrd.kr/
   ```
4. **재부팅을 최소 2회 반복**하고, **마지막(2번째 이후) 실행에서만** 아래
   pass 기준을 판정한다. 1차 실행에서 대화상자가 뜨는 것 자체는 실패가
   아니다 — 그건 게이트가 존재를 확인해준 것이고, 그 게이트를 승인한
   뒤의 2차 실행이 진짜 판정 대상이다.

**Pass 기준(2차 실행 기준, 전부 충족):**
- `kr.ygrd.wagcrm.app` PID 값이 존재(빈 값·`-` 아님).
- `kr.ygrd.wagcrm.tunnel` PID 값이 존재(빈 값·`-` 아님).
- Supabase 컨테이너 11개가 기동 중(`docker ps` 로 셀 때 11).
- 터널 도메인 HTTP 응답이 200.
- 재부팅 과정에서 화면에 뜨는 승인/확인 대화상자가 **없음**(사람 개입 0회).

## 컷오버(cutover) — Phase 7

프로덕션 호스트네임(`crm.ygrd.kr`)을 이전 클라우드 배포에서 이 iMac
스택으로 넘기는, 이 프로젝트에서 유일하게 "되돌리기 어렵다고 느껴지는"
순간이다. 그래서 기억에 의존한 명령 나열이 아니라
`infra/selfhost/cutover.sh` 라는 리허설된·게이트가 걸린·재개 가능한
스크립트로 만들었다(계획 원본:
`docs/private/plans/2026-08-12-imac-selfhost-migration.md` Phase 7,
Task 13~14). 실행 전 그 문서와 이 절을 먼저 읽을 것.

### 사전조건(Phase 6 전환 게이트가 전부 초록이어야 함)

로그인·대시보드·정산·캠페인·셀러 포털 실렌더 + 콘솔 에러 0, 조회성 크론
3일 연속 정상 발화, 재부팅 무인 복구 통과, R2 백업+복원 리허설 통과, DB·
Storage 정합 검증 통과, **오너의 명시적 "전환한다" 승인**. 이 중 하나라도
안 됐으면 `cutover.sh` 를 돌리지 않는다.

### 절차(Stage 1~9, `cutover.sh`)

```bash
./infra/selfhost/cutover.sh --dry-run   # 먼저 계획만 확인(아무 것도 안 건드림)
./infra/selfhost/cutover.sh             # Stage 1 부터 실행
```

각 Stage 는 ①무엇을 할지 출력 → ②실행 → ③검증까지 마쳐야 다음 Stage 로
넘어간다. 실패하면 항상 nonzero exit + 어느 Stage 가 실패했는지·지금
시스템이 어떤 상태인지·어떻게 재개하는지를 한국어로 출력한다.

1. **사전 점검** — 자체호스팅 앱 서빙+DB 연결, 오늘자 R2 백업 존재, 크론
   공백 시간대(KST 14:00~21:59) 안, 운영 체크아웃 경로(개발 워크트리
   아님), **필수 실행파일이 PATH 에서 잡히는지**(`psql`·`pg_dump`·docker·
   rclone·jq·curl·node·npx·cloudflared), **`.env.cutover` 3개 키가
   비어있지 않은지**. 하나라도 FAIL 이면 아무 것도 건드리지 않고 중단.

   ⚠️ macOS 의 libpq 는 brew keg-only 라 `/usr/local/bin` 에 링크가 생기지
   않는다 — 대화형 셸에도 `psql` 이 없다(실측). Stage 3a 는 클라우드
   원본을 떠야 해서 `docker exec` 로 대체할 수 없으므로 호스트 클라이언트가
   필요하고, 그래서 이 스크립트는 상단에서 libpq keg 경로까지 PATH 에
   얹는다. 다른 기계로 옮길 때 keg 경로가 다르면 그 목록을 갱신할 것.
2. **백업 선행** — `backup.sh` 재사용. 실패하면 절대 다음 단계로 가지 않음.
3. **최종 데이터 재동기화** — 클라우드 public 데이터를 먼저 덤프·검증한
   뒤에만 로컬 public 스키마를 드랍→Prisma 마이그레이션으로 재구축→전체
   재주입(부분 머지 아님). `auth.users`/`auth.identities` 는 스키마는
   그대로 두고 행만 ID 보존 upsert(README 위쪽 "auth 를 통째로 복원하면
   안 되는 이유" 참고). storage 객체는 `scripts/migrate-storage-objects.ts`
   로 증분 재이관(멱등). 이 Stage 전체가 멱등이라 `--stage 3` 재실행은
   항상 안전하다.
4. **정합성 검증** — 테이블별 행수, `auth.users` ID **집합**(개수 아님)
   완전 일치, 소유권 참조(`createdBy`/`userId`) 고아 0건, 버킷별 객체 수.
   하나라도 FAIL 이면 트래픽 전환 전에 중단.
5. **앱 공개 origin 전환** — `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_SITE_URL`
   은 빌드 타임에 인라이닝되므로 재시작이 아니라 재빌드가 필요하다.
   `.env` 갱신 → `deploy.sh`(`FORCE=1`) 재빌드+재기동 → 빌드 산출물에서
   신규 origin 반영 확인.
   ⚠️ **확인 대상은 `.live/current/.next/server` 다**(client `static` 아님).
   ⛔ 종전 경로 `.next/standalone/.next/server` 는 SUPERSEDED — `deploy.sh` 가
   산출물을 `.live` 로 **옮기므로** 배포 성공 후 그 경로는 존재하지 않는다
   (2026-08-29 안전장치 ⑧. `cutover.sh` Stage 5 도 같은 경로로 고쳤다). 이 앱에서 그 두 변수를 읽는 표면은 전부 서버 컴포넌트·라우트
   핸들러라 클라이언트 번들에는 애초에 들어가지 않는다 — `static` 만 보면
   정상 재빌드에서도 "반영 안 됨"이 나온다(2026-08-13 실측). 신규 origin
   존재(양성)와 구 origin 부재(음성)를 함께 보되, 구 origin 이 루프백이면
   음성 대조는 스킵한다(소스의 `localhost:3000` 폴백 리터럴 때문).
6. **인증 서비스(GoTrue) origin 전환** — Supabase 스택 `.env` 의
   `SITE_URL` 만 정밀 치환하고 `auth` 서비스만 재기동.
   ⚠️ **적용 확인은 컨테이너의 `GOTRUE_SITE_URL` 로 읽는다** — compose 가
   `.env` 의 `SITE_URL` 을 GoTrue 접두사 규약에 맞춰 주입하므로 컨테이너
   안에 `SITE_URL` 이라는 이름은 없다(`printenv SITE_URL` 은 항상 exit 1).
   ⚠️ **그 `.env` 를 이 셸에 `source` 하지 않는다** — JSON 값을 담은
   변수가 있어 `source` 하면 셸이 따옴표를 벗기고, `docker compose` 는
   그 뒤 `--env-file` 로 준 파일 값보다 이미 셸에 export 된 값을
   우선하므로 벗겨진 값이 컨테이너에 주입돼 크래시루프가 난다.
   `cutover.sh` 는 이 파일을 sed 로만 고치고 `docker compose` 는 항상
   `--env-file` 로 경로만 넘긴다 — 수동으로 다시 만질 때도 이 규칙을
   지킬 것.
7. **프로덕션 호스트네임 라우팅** — cloudflared ingress 에 `crm.ygrd.kr`
   추가 → `cloudflared tunnel route dns` → 터널 서비스만 재기동 → 외부
   서빙 확인.
   ⚠️ **`/` 의 200 으로 판정하지 않는다.** 미인증 `/` 는 인증 게이트가
   `/login` 으로 307 을 주므로 정상 상태에서도 200 이 아니고, 구 배포도
   같은 앱이라 똑같이 307 을 준다 — 상태코드는 신·구를 가르지 못한다.
   판별자는 ⓐ `/login` 200 + ⓑ 응답에 이전 플랫폼의 엣지 헤더
   (`x-vercel-id`) 부재다. 수동 확인도 같은 기준으로 한다:
   `curl -sS -o /dev/null -D - https://crm.ygrd.kr/login`.
8. **보류 크론 5개 활성화** — `--confirm-old-cron-off` 플래그 없이는
   진행하지 않는다. 대화형 실행이면 정확한 확인 문구(`OLD CRON DISABLED`)
   입력도 추가로 요구한다. **이전(클라우드) 배포의 크론이 완전히 꺼졌음을
   먼저 확인**할 것 — 양쪽이 동시에 발화하면 네이버 주문/정산 동기화·
   세금계산서 확인·미디어 재호스팅·인스타그램 토큰 갱신이 이중 실행돼
   외부 시스템에 실제 사고가 난다.
9. **컷오버 후 검증** — 프로덕션 호스트네임을 자체호스팅 스택이 서빙
   (Stage 7 과 **동일 판별자**, 로그인 화면 렌더를 포함한다), 미인증
   접근의 로그인 리다이렉트, DB 연결, 앱 크론 전량 활성(개수는 crontab 파일에서 센다), 백업 스케줄
   (일간+주간) 2개 등록을 재확인.

> 위 Stage 5·6·7·9 의 검사 계약은 `scripts/__tests__/cutover-verifiers.test.ts`
> 가 고정한다(2026-08-13 실행에서 네 검사가 전부 정상 상태를 실패로 판정한
> 뒤 신설). 검사 조건을 바꾸려면 그 테스트를 함께 고칠 것 — 판정 기준을
> 조용히 되돌리면 다음 컷오버가 같은 지점에서 또 멈춘다.

### `.env.cutover` — 컷오버 전용 크리덴셜(git 미추적)

`infra/selfhost/.env` 와 별개로, 클라우드 원본 접속 정보만 담는 파일이다
(`.env*` 패턴에 걸려 자동으로 git 미추적 — 위 ".env 경고" 절 그대로
적용된다, 절대 커밋하지 않는다). Stage 3~4 가 이 파일을 요구한다:

| 변수 | 값 |
| --- | --- |
| `PROD_URL` | 클라우드 Postgres 직결 연결 문자열(`pg_dump`/`psql` 용) |
| `SRC_URL` | 클라우드 Supabase Storage API 엔드포인트 |
| `SRC_SERVICE_KEY` | 클라우드 Supabase service_role 키 |

### 실패 후 재개 — `--stage N`

```bash
./infra/selfhost/cutover.sh --stage 5   # Stage 1(사전 점검)은 항상 재확인 후 Stage 5 부터 재개
```

Stage 3(데이터 재동기화)은 통째로 멱등하게 설계했다 — 드랍→재구축→전체
재주입 순서라 중간에 죽어도 `--stage 3` 재실행이 처음부터 다시 하므로
부분 상태가 누적되지 않는다. 다른 Stage 도 각자 실패 메시지에 "무엇이
이미 바뀌었는지"를 명시한다 — 재개 전에 그 메시지를 반드시 읽을 것.

### 롤백 — `rollback.sh` 와 그 한계

```bash
./infra/selfhost/rollback.sh
```

프로덕션 호스트네임을 클라우드 배포로 되돌리는 ingress 제거·터널
재기동, 보류 크론 5개 재잠금(주석 재처리)까지만 자동화한다. Cloudflare
DNS 를 실제로 클라우드 배포로 되돌리는 것과 클라우드 배포 쪽 서비스
재활성화는 계정 권한이 필요한 수동 작업이라 스크립트가 대행하지 않는다
(실행 시 정확한 다음 단계를 안내한다).

⚠️ **롤백이 복구하지 못하는 것: 컷오버 이후 자체호스팅에 새로 쓰인
데이터.** 롤백은 호스트네임과 크론만 되돌릴 뿐, 클라우드 배포는 컷오버
이후 자체호스팅에서 일어난 어떤 쓰기도 알지 못한다. 컷오버~롤백 사이에
생성/수정된 캠페인·정산·업로드 파일은 사용자 눈에는 사라진 것처럼
보인다(실제로는 자체호스팅 DB/스토리지에 남아있지만 클라우드 쪽엔 존재한
적이 없다). 이 기간 크론이 이미 일으킨 외부 부수효과(주문 상태 변경,
발행된 세금계산서, 무효화된 토큰)도 되돌려지지 않는다. 그래서 계획서
(Task 15)는 롤백을 "중대 장애 시에만"으로 한정한다 — 되돌리려면 그 사이
데이터를 클라우드로 역이관하는 별도 작업이 필요하다.

### 컷오버 후 며칠간 확인할 것

- 시스템 레이더에서 앱 크론 전부 매일 정상 발화(누락 0).
- `~/selfhost/logs/backup.out.log`/`backup-weekly.out.log` 에 실패 없음
  (R2 파일 수가 실제로 늘고 있는지도 가끔 확인).
- 외부 모니터링(UptimeRobot 등)에 다운타임 기록 없음.
- 네이버 주문/정산 동기화·세금계산서 확인이 이중 실행 흔적 없이 1회씩만
  기록되는지(과거엔 클라우드+iMac 양쪽 크론이 겹쳐 발화할 위험이 있던
  잡들).
- 계획서 Task 15 대로 Vercel·Supabase 클라우드는 최소 1개월 결제 유지
  상태로 롤백 창구를 살려둔다 — 해지는 오너가 직접(P0, 결제 변경은
  에이전트 대행 불가).
