# Deployment, Database & Release Discipline — P6 (AGENTS.md 라우터 모듈)

> `AGENTS.md`의 Mandatory Reading Router가 지정하는 조건부 필독 모듈이다.
> 커밋·푸시·PR·배포·마이그레이션·크론·시크릿 작업 전에 **전문**을 읽는다.
> 이 모듈의 규칙은 실사고(CLI 배포 경합, 크론 무증상 정지, 지표 부풀림)에서
> 나왔다 — 전 레인(Claude·Codex·Antigravity) 공통 적용이다.

- **Repo Migration — 저장소가 셋이고 번호가 겹친다:** 이관이 두 번 있었다.
  `indexzigu/wag-crm`(최초) → `indexzigu/wagcrm`(2026-07-16) →
  **`indexzigu/wagcrm_git`(2026-08-28, 현행)**. 세 번 다 **이력을 공유하지 않고
  재출발**(unrelated history)했으므로 PR·커밋 번호가 매번 **#1부터 다시 시작**한다
  → **세 레포에 같은 번호가 공존**한다(예: `#4` 는 셋 중 어느 것일 수도 있다 —
  **번호만으로 레포 특정 불가**). 2026-08-28 이관 사유는 구 레포 이력의 개인정보를
  제거할 수 없어서다(`AGENTS.md` Project Identity). 판별 규칙:
  - **현행 작업(push·PR·머지·배포)은 언제나 신 `indexzigu/wagcrm_git`** 기준이다.
    ⚠️ 기존 워크트리의 `origin` remote는 **여전히 구 레포**를 가리킬 수 있어
    `git push`가 조용히 구 레포로 간다(오배송) — `git remote -v`로 신 레포인지
    확인하고 push한다.
  - **옛 PR·설계 근거 조회**는 구 레포를 **읽기 전용 아카이브**로 취급한다:
    `gh pr view <N> -R indexzigu/wag-crm`,
    `gh pr list -R indexzigu/wag-crm --state all --search "<키워드>"`,
    코드 히스토리는 `gh api repos/indexzigu/wag-crm/...`. 두 레포 다 private라
    `gh`(오너 권한)로만 열린다(브라우저 타 계정은 404).
  - **어느 레포인지 애매하면** 참조 시점으로 가른다: **2026-07-16 이전**
    사고·PR·커밋(`46f8b87` 이하) = `wag-crm`, **07-16 ~ 08-28** = `wagcrm`,
    **08-28 이후** = 현행 `wagcrm_git`. 그래도
    불확실하면 양쪽을 조회해 생성시각·제목으로 대조한다(구 레포에 남은 열린
    PR은 이관 전 잔재일 수 있다). **신규 PR·이슈·머지를 구 레포에 만들지
    않는다.**

- **Deploy Path Is PR-Merge Only:** 프로덕션 배포 경로는 `origin/main에서
  분기한 격리 워크트리 → push → PR → 오너 머지(main 통합) →
  scripts/promote-prod.sh 승격(main→release fast-forward) → Vercel Git 자동
  배포`가 유일하다. 로컬 `vercel --prod` 직배포는 로컬 트리 전체로 프로덕션을
  덮어 타 세션 작업을 드롭한(last-writer-wins) 실사고가 있어 금지한다.
  **머지 ≠ 배포다(2026-07-24 승격 레인 전환):** PR 머지는 main 통합일 뿐
  빌드를 만들지 않는다. 배포는 승격 시점에 일어나며, 승격 1회에 그때까지
  쌓인 머지 전부가 빌드 1회로 실린다 — "머지를 미루는 배칭"이 아니라 "배포
  시점만 분리하는 배칭"이라 작업 흐름(머지 후 후속 작업)은 막히지 않는다.
  배경: 머지=즉시빌드 시절 main 머지 50회/4일 × 회당 ~20 CPU분이 Pro 포함
  크레딧($20/월)을 소진하는 페이스였다(2026-07-24 실측).

- **Two Projects, Three Branches (통합 main · 운영 release · 데모 demo):**
  ⛔ **절 이름의 「Two Projects」는 더 이상 사실이 아니다 — Vercel 프로젝트는 `wag-crm`
  1개뿐이다**(2026-08-26 실측: 계정 `indexzigus-projects` 의 프로젝트 목록에 `wag-crm`
  하나이고 `wagcrm-demo` 는 없다). **이름은 그대로 둔다** — 아래 세 곳이 「위 Two Projects
  항목」으로 이 절을 참조하므로 바꾸면 그 참조가 끊긴다. ⚠️ **사라진 것은 데모 프로젝트이지
  이 절의 교훈이 아니다** — 「초록으로 보이는 미배포」(#68~#72)는 프로젝트 개수와 무관한
  실패 양식이고, 아래 브랜치 레인 구분도 `release`·`main` 은 그대로 유효하다.
  종전에 이 레포는 Vercel 프로젝트 **2개**가 봤다 — `wag-crm`(운영, crm.ygrd.kr)과
  `wagcrm-demo`(외부 시연). 두 프로젝트가 같은 브랜치를 보면 머지 1번에 둘 다
  빌드되고(데모 헛빌드), 이를 막으려 넣은 인라인 `Ignored Build Step` 한 줄이
  **운영 배포를 다섯 건 연속 삼킨 실사고**가 있다(#68~#72, 2026-07-22 —
  커밋상태는 `Vercel – wag-crm: success` 인데 description 이
  `Canceled by Ignored Build Step`, 즉 초록으로 보이는 미배포). 그래서 레인을
  브랜치로 가른다:
  - `main` = **통합 브랜치, 빌드 없음.** PR 머지가 착지하는 곳이자 모든
    분기의 base. Vercel 배포를 생성하지 않는다(`deploymentEnabled.main:
    false`) — 머지가 공짜이므로 작업 단위로 자유롭게 머지한다.
  - `release` = **구 플랫폼 롤백 창구**(2026-08-13 컷오버 이후). `main` 의
    fast-forward 로만 갱신 — `bash scripts/promote-prod.sh` (드롭체크·ff 강제·배포
    description 확인 폴링 내장). ⛔ 이전 서술 "`release` = 운영 레인"은 SUPERSEDED —
    운영 트래픽은 자체호스팅이 받고 이 레인은 롤백할 때만 수동으로 올린다(아래
    Promotion Policy). 그 전 서술 "main = 운영 레인, PR 머지 → 자동배포"도 무효다
    (2026-07-24 승격 레인 전환 — 빌드 비용 배칭).
  - `demo` = 데모 레인. ⛔ **지금은 죽은 레인이다 — `main:demo` push 는 아무 배포도
    만들지 않는다**(2026-08-26 실측: 브랜치 `demo` 는 원격에 살아 있지만 그것을 보던
    `wagcrm-demo` 프로젝트가 없다). `vercel.json` 의 `deploymentEnabled.demo: true` 와
    `scripts/vercel-ignore-build.sh` 의 `demo` 레인은 그대로 남아 있다 — 가리키는
    프로젝트가 없어 무해하지만, 되살리려면 **프로젝트부터 다시 만들어야 한다**(그때
    아래 「Demo Deployment」 의 env 3개 규약을 그대로 따른다). 아래는 그 시절 규약이다:
    `main` 의 fast-forward 로만 갱신
    (`git push newrepo main:demo`) → `wagcrm-demo` 만 배포. 데모를 새로
    보여줄 일이 있을 때만 밀어 올린다(평소엔 데모가 뒤처져 있어도 정상).
    **갱신은 수동 유지가 오너 확정이다(2026-07-22)** — 주기적 자동 동기화
    워크플로를 붙이지 않는다. 시연 상태를 의도적으로 얼려 둘 수 있는 것이
    "항상 최신"보다 중요하다는 판단이다.
  - 각 프로젝트의 Ignored Build Step 은 **인라인 명령 금지**, 반드시
    `bash scripts/vercel-ignore-build.sh <레인>` 형태로 스크립트에 위임한다
    (`release` / `demo`). 판정은
    `scripts/__tests__/vercel-ignore-build.test.ts` 가 고정한다.
  - ⚠️ **종료코드 계약은 직관과 반대다: `exit 1` = 빌드 진행, `exit 0` =
    빌드 취소.** 여기를 뒤집으면 "성공처럼 보이는 영구 미배포"가 된다.
    판정 불능이면 언제나 빌드 쪽(=1)으로 넘어진다.
  - **배포 확인은 state 만 보지 말고 description 까지 읽는다**:
    `gh api repos/indexzigu/wagcrm_git/commits/<sha>/status --jq '.statuses[]|"\(.context) \(.state) \(.description)"'`
    → `Deployment has completed` 여야 실배포다.

- **Promotion Policy — 승격은 수동 전용이다 (2026-08-13 자체호스팅 컷오버, 오너 지시
  "promote-auto 는 끄고, 롤백은 그때 수동 승격하자"):** 프로덕션은 집 iMac 이 서빙하고
  `release` 는 **구 플랫폼 롤백 창구**로만 남는다. 자동 승격을 켜 두면 이관 후에도
  4시간마다 구 플랫폼 빌드를 태운다(한 달 병행 관찰 내내).
  - **발화 경로는 `workflow_dispatch` 하나**: Actions → Promote (auto) → Run workflow,
    또는 로컬 `bash scripts/promote-prod.sh`. 누르면 미승격을 전부 승격한다 — 문턱을
    남기면 "눌렀는데 아무 일도 안 일어나는" 조용한 skip 이 된다.
  - **롤백 시 순서: ①자체호스팅 크론을 먼저 끈다 → ②수동 승격 → ③(길어지면)
    `vercel.json` crons 복원 PR.** ③ 을 ① 보다 먼저 하면 양쪽 동시 발화가 되고,
    이는 컷오버 Stage 8 이 막으려던 사고를 반대 방향으로 일으키는 것이다.
    ⛔ 종전 서술 "승격이 만드는 새 배포가 구 크론을 되살린다"는 **SUPERSEDED**
    (2026-08-15 crons 제거) — 이제 자동 부활이 없다(안내 정본 `rollback.sh` Step 4).
  - **셀프호스트 `deploy.sh` 는 `main` 을 추종한다**(같은 날 전환) — 머지 → `git pull`
    로 반영되고 승격이 개입하지 않는다. 종전에는 `origin/release` 로 하드 리셋해서,
    컷오버 당일 스크립트를 고칠 때마다 머지→승격→pull 을 반복해야 했다.
  - **`--check` 의 두 문턱은 의미가 바뀌었다**: "곧 자동 승격이 발화할 나이인가"가
    아니라 **"롤백 창구가 얼마나 낡았는가"**. 낡아도 프로덕션에는 영향이 없다.
    자동 트리거가 조용히 되살아나지 않도록 `promote-prod-check.test.ts` 가 `on:` 블록을
    고정한다 — 되살아나도 **아무 것도 실패하지 않아** 사람이 알아차릴 계기가 없기 때문이다.
  - ⛔ **건수 상한(`push:main`, `COUNT_THRESHOLD` ≥5) · 시간 상한(`schedule` 4h) ·
    긴급 오버라이드(`[promote]`/`[deploy]` 마커)는 SUPERSEDED** — 2026-07-24~08-13 사이의
    자동 승격 정책이다. 그 시절 배포를 되짚을 때만 참고하고 현행 판단 근거로 쓰지 말 것.
    (마커 판정 코드 자체는 워크플로에 남아 있다 — 수동 실행 로그에 "왜 갔는지"가
    남는 편이 낫다는 판단이며, 그것이 자동 발화를 뜻하지는 않는다.)
  - **실패는 삼키지 않는다**: 승격/배포 실패 시 워크플로가 실패하고 `promote-failed`
    라벨 이슈를 연다(중복이면 코멘트). 빌드 깨지는 커밋은 Vercel 빌드가 실패해 **prod 를
    바꾸지 못하고**(기존 배포 유지) 여기서 감지된다. ⚠️ **수동 실행도 같은 감시선에
    걸린다(2026-08-02)** — `promote-prod.sh`(`--yes`·`--poll-only` 둘 다)의
    `poll_deployment`가 취소·실패·타임아웃으로 끝나면 같은 `promote-failed` 라벨로
    이슈를 연다. 실사고: 사람이 직접 돌린 승격에서 push는 성공했는데 폴링이
    15분 타임아웃되자 그 사실이 터미널 밖으로 안 나가 아무도 몰랐다 — 코드는
    `release`에 이미 올라갔지만 배포 확인은 안 된 상태로 방치될 뻔했다. 이슈 열기
    자체가 실패해도(권한 부족 등) 폴링의 종료코드는 절대 바뀌지 않는다.
  - ⛔ **종전 서술 「안전 backstop 은 이미 적용돼 있다 — `main-protection` ruleset(active)이
    `guard`·`preflight`·`test` 를 required 로 … 강제한다」는 SUPERSEDED (2026-08-26 비공개
    전환, T-069).** GitHub 무료 플랜은 **비공개** 저장소에서 rulesets/branch protection 을
    정지시킨다(실측 2026-08-27: rulesets 계열 API 전부 403 `Upgrade to GitHub Pro` ·
    GraphQL `refUpdateRule` null · PR #501 은 required 검사 시작 16분 전에 머지됨 ·
    PR #502 는 `guard` 미실행 상태로 머지됨). 지금 main 은 검사 미통과 머지·직접 push·
    force push 가 **서버에서 막히지 않는다** — 방어는 아래 「Main Push Guard & Deploy CI
    Gate」가 이 맥에서 대신한다. 그 전의 SUPERSEDED("main 은 브랜치 보호가 없어 …" →
    2026-07-30 중복 설정 실사고)는 역사 기록으로 유지하되, **그 문장은 지금 다시 사실이
    됐다** — 다만 근거가 다르다(설정 부재가 아니라 플랜 게이트라, 켜서 고칠 수 없다).
  - ✅ **공개 전환으로 이 제약이 풀린다 (2026-08-28) — 미결 과제다.** 위 403 메시지가
    말하는 두 출구가 "유료 전환"과 **"공개로 전환"** 이었고, 이 레포는 후자를 택했다.
    ⇒ **rulesets/branch protection 을 다시 켤 수 있다.** 아직 설정하지 않았으므로
    지금은 여전히 무보호 상태다 — `main` 직접 push·검사 미통과 머지가 서버에서
    막히지 않고, 방어는 아래 「Main Push Guard & Deploy CI Gate」가 이 맥에서 한다.
    ⚠️ **켤 때 종전 실사고를 되풀이하지 말 것**: 2026-07-30 에 같은 보호를 **중복
    설정**해 진단이 꼬였다. 켜기 전에 `gh api repos/indexzigu/wagcrm_git/rulesets` 로
    **기존 규칙이 없음을 먼저 확인**하고, 필수 체크 이름은 실제 잡 이름
    (`guard`·`preflight`·`test`)과 글자 단위로 맞춘다.
  - ⚠️ **보호 여부 확인은 rulesets API 로 한다:**
    `gh api repos/indexzigu/wagcrm_git/rulesets`. **비공개 무료 플랜에서는 403 이
    "규칙 없음"이 아니라 "기능 자체 잠김"이었다** — 구 레포에서 옛 `main-protection`
    ruleset 이 서버에 보존돼 있는지조차 읽을 수 없었다.
    그때를 위해 종전 함정 2개를 남긴다: ① classic API(`branches/main/protection`)의
    404 를 무보호 근거로 쓰지 말 것 — 그쪽은 ruleset 을 원래 못 본다. ② 상세 조회에서
    `--jq` 로 `.rules[].parameters` 를 좁혀 읽으면 `rules: []`(규칙 없음)처럼 보인다 —
    `rules` 배열 길이를 먼저 확인하고 필요하면 raw JSON 을 읽는다.
  - 자동 push 에는 `contents:write` 가 필요 — 403 이면 Settings → Actions → General
    → Workflow permissions 를 "Read and write" 로(오너 1회).

  ⛔ 이전 방침(같은 날 초안 "승격 실행 자동화 금지 — 배포 시점은 사람" + 판단 넛지 이슈만)은
  오너 지시로 SUPERSEDED. 레인 브랜치가 아닌 푸시는
  Vercel 배포를 **아예 생성하지 않는다**(`vercel.json`의
  `git.deploymentEnabled: {release:true, demo:true, main:false, "*":false, "**":false}`). 이 설정을
  넣은 계기는 **Hobby**의 동시 빌드 1개·일 100개 한도였다 — 프리뷰 배포가
  생성되면 프로덕션 빌드를 큐에서 지연시키고 한도를 소진했다(#91·#92 무발화의
  원인). **이 설정은 유지한다.** ⛔ 종전 유지 근거 「**Pro 전환 후에도 유지한다**: 큐
  고갈은 풀렸지만 프리뷰 빌드가 여전히 포함 크레딧을 태우기 때문」은 **SUPERSEDED**
  (2026-08-26 실측 — 플랜이 다시 `hobby` 다, 아래 Plan Limits). 지금 유지하는 이유는
  크레딧이 아니라 **애초의 이유가 되살아났기 때문**이다: 동시 빌드 1개·일 100개 한도가
  다시 걸린다. `ignoreCommand`(빌드를
  생성한 뒤 취소 — 배포 기록·큐 점유는 남음)와 달리 이 방식은 배포 자체를
  만들지 않아 큐·기록·한도를 전혀 건드리지 않는다. 머지 전 검증은 GitHub
  Actions release-preflight(PR 트리거 — fresh-install 빌드 + hermetic
  테스트)가 대신한다. 프리뷰 URL이 정말 필요하면 `vercel` CLI로 수동
  배포한다(자동 옵트인 마커는 없다).

- **Main Push Guard & Deploy CI Gate — 브랜치 보호의 대체 방어 2문 (T-069, 2026-08-27):**
  2026-08-26 비공개 전환으로 GitHub 무료 플랜이 브랜치 보호를 정지시켜(위 Promotion
  Policy 의 403 실측) required 검사·PR 필수·force push 금지가 전부 서버에서 사라졌다.
  오너 결정(2026-08-27): 유료 전환·재공개 없이 **방어를 이 맥으로 옮긴다** — #481
  하이브리드 CI(러너 이전)와 같은 방향(GitHub 의존 축소, 무료 할당량은 유지)이다.
  - **문① `.githooks/pre-push`** — main 으로의 직접 push(force push·삭제 포함)를 push
    직전에 거부한다. 비상 우회 `ALLOW_MAIN_PUSH=1`.
    - 🪤 **머지만으로는 발효되지 않는다 — 기계에 반영하는 것은 사람 몫이다**(크론
      미재설치 함정과 같은 형태, 아래 「Self-Hosted Preflight Runner」 위 절 참조).
      배선 실측(2026-08-27): 워크트리 15개와 메인 레포의 `core.hooksPath` 는 **절대경로**
      `/Users/z9/Projects/wag-crm/.githooks` 라, git 이 실행하는 것은 언제나 **메인 레포
      작업트리의 파일 하나**다. 워크트리에 있는 사본은 git 이 보지 않는다. 반면 셀프호스트
      체크아웃 2개는 **상대경로** `.githooks` 라 자기 사본을 쓴다(배포 pull 로 자동 반영).
    - **발효 절차(머지 후 1회):** 메인 레포 체크아웃을 이 커밋을 담은 브랜치로 갱신한다.
      메인 레포는 `main-local`(upstream `origin/main`)에 있으므로 `git -C
      /Users/z9/Projects/wag-crm pull --ff-only`. 갱신되는 순간 **15개 워크트리 전부에
      동시에** 발효한다(공유 파일이므로).
    - **발효 확인:** `test -x /Users/z9/Projects/wag-crm/.githooks/pre-push && echo 발효`.
      ⛔ 워크트리 안의 `.githooks/pre-push` 존재로 판정하지 말 것 — 그건 git 이 안 보는
      사본이라 **있는데 안 도는** 상태를 정상으로 오독한다(초판이 실제로 그렇게 판정했다가
      로컬 bare 저장소 push 프로브에서 잡혔다 — 스크립트 단독 실행 6케이스는 전부 통과하는데
      실제 `git push origin HEAD:main` 은 그냥 성공했다).
  - **문② `deploy.sh` 안전장치 ⑦(배포 직전 CI 게이트)** — 프로덕션 배포 직전, 나가는
    커밋 구간(마커..origin/main)의 각 커밋을 원 PR 로 되짚어 required 3종
    (`guard`·`preflight`·`test`) 전부 success 인지 확인한다. **연결 PR 없는 커밋(= main
    직접 push)도 거부한다.** 판정 불능(gh 부재·미인증·네트워크)은 fail-closed, 비상 우회
    `SKIP_CI_GATE=1`(FORCE=1 과 같은 결 — 로그에 남는다).
    ⚠️ main 커밋 자체의 검사로 판정하지 말 것 — main push run 에는 `guard` 가 아예 없고
    `test` 는 skip 이라(실측) 항상 미달로 보인다. squash 전용 레포라 main 커밋 1개 =
    머지된 PR 1개가 성립해 `commits/<sha>/pulls` 되짚기가 정확하다.
    - **마커 판정 불가(유실·이력 재작성) 시엔 최신 20커밋만 훑고 「그보다 오래된 것은
      미검증」이라고 말한다.** ⛔ 여기서 fail-closed 로 가지 말 것 — 마커 유실만으로
      배포가 영구 차단되면 운영자가 `SKIP_CI_GATE=1` 을 습관으로 쓰게 되어 게이트
      전체가 죽는다. ⛔ 창을 1커밋으로 좁히지도 말 것(초판이 그랬다 — 마커 유실 사이에
      쌓인 커밋을 조용히 통과시켜, 이 게이트가 막으려는 형태를 스스로 만들었다).
    - `gh` 인증은 launchd 경로에서 성립한다(2026-08-27 실측: LaunchAgent 프로세스 환경에
      `HOME` 존재 + 같은 경로의 `status.sh` 가 이미 인증된 `gh api` 2건을 낸다). 그래도
      인증이 깨지면 `gh api` 실패 → fail-closed 라 "검증 없이 배포"가 아니라 "배포 차단"
      으로 나타난다.
  - **정직한 한계:** 문①은 `--no-verify`·GitHub 웹 UI·`gh pr merge`(git 을 거치지 않는
    API 직행)·이 맥 밖의 머신을 못 본다 — 그 경로들은 문②가 prod 직전에 잡는다. 문②로도
    못 막는 것은 **main 이력 손상**(force push)뿐이다 — 서버측 차단이 없으므로 P0
    「Critical Data Loss」 조항이 유일한 방어선이다.
  - **메뉴바 두 행(`actionsQuota`·`preflightRunner`)의 경보 의미가 뒤집혔다:** 종전엔
    「required 라서 한도 소진·러너 정지 = 전 PR 머지 불가(시끄러운 고장)」였는데, 보호
    정지로 「머지는 되고 검증 없이 나간다(조용한 고장)」가 됐다. 행의 필요성은 그대로다 —
    문②가 미검증 머지를 배포 직전에 잡으므로, 이 행들은 "배포가 막히기 전에 미리 아는"
    조기 신호로 역할이 바뀌었다.
  - 짝 계약: `main-push-guard.contract.test.ts`(훅 실동작 + 게이트 앵커·순서·fail-closed).
    ⚠️ 이 계약은 **레포 안의 파일**만 본다 — 위 발효 여부는 기계 상태라 CI 러너에서
    판정할 수 없다(테스트 초록 ≠ 훅이 돈다). 그래서 발효 확인은 위 명령으로 사람이 한다.

- **셀프호스트 레인은 둘이다 — 프로덕션(3000)과 프리뷰(3001) (2026-08-13 프리뷰 서버 구축):**
  같은 iMac 이 두 인스턴스를 서빙한다(프리뷰는 **온디맨드** — `preview.sh up [<브랜치>]`/`down`,
  닫힌 동안 `crm-test` 502 + DB 컨테이너 부재가 정상 상태다. 2026-08-13 전환).
  **어느 레인을 조작하는지 먼저 확정하고 손을 댄다** —
  둘은 `deploy.sh`·`run-app.sh` 를 **공유**하고 env 로만 갈리므로, 오버라이드를 빠뜨리면
  프리뷰 명령이 프로덕션에 걸린다. 운영 좌표 정본은 `infra/selfhost/README.md`
  「프리뷰(스테이징) 레인」이고 여기엔 **판단 규칙만** 둔다.
  - **레인 선택은 env 3개다:** `APP_PORT` · `APP_LAUNCHD_LABEL` · `APP_TRACK_BRANCH`
    (2026-08-13 온디맨드 전환에서 추가 — 프리뷰가 머지 전 브랜치를 띄우는 통로).
    안 주면 **프로덕션**(3000 / `kr.ygrd.wagcrm.app` / `main`)이다 — 기본값이 프로덕션이라는
    것이 이 설계의 위험 지점이자 의도다(잊으면 프리뷰가 안 뜨지, 프로덕션이 엉뚱한 곳을
    보지는 않는다). 프로덕션 기본값 불변은
    `scripts/__tests__/selfhost-lane-defaults.test.ts` 가 고정한다.
    ⛔ 단 `APP_TRACK_BRANCH` 만은 프로덕션 레인에서 **거부된다**(무시가 아니라 exit 1) —
    프리뷰를 만지던 셸에 남은 export 하나로 프로덕션이 기능 브랜치를 빌드해 서빙하는데,
    헬스체크·마커가 전부 정상이라 **조용한 오배포**가 되기 때문이다. 값이 `main` 이어도
    거부한다(설정돼 있다는 것 자체가 셸 오염의 신호다). `unset` 후 재실행할 것.
  - ⚠️ **배포 마커는 레인마다 갈라야 한다.** `MARKER_DIR` 이 체크아웃의 **부모** 디렉터리에서
    나오는데 두 체크아웃(`~/selfhost/wagcrm` · `~/selfhost/wagcrm-preview`)의 부모가 같은
    `~/selfhost` 라 디렉터리가 겹친다. 파일명까지 같으면 프리뷰 배포가 프로덕션 마커를
    덮어쓰고, **두 레인 모두 `main` 을 추종하므로 SHA 까지 일치**해 프로덕션 `deploy.sh` 가
    "변경 없음" 으로 **조용히 종료**한다 — 프로덕션은 구버전을 서빙 중인데 마커는 최신인,
    그 스크립트가 애초에 방어하려던 실패 모드다. 지금은 라벨에서 파생한다
    (프로덕션 `deployed.sha` / 그 외 `deployed.<라벨끝>.sha`) — 새 레인이 지정을 잊을 수 없다.
  - ⛔ **프리뷰에 앱 크론을 설치하지 않는다.** 프리뷰 DB 는 프로덕션 사본이라, 크론이 돌면
    발주 메일·네이버 동기화 같은 **실제 외부 부수효과**가 실제 셀러·거래처를 상대로 발화한다.
    `infra/selfhost/crontab` 에는 프리뷰 관련 줄이 **하나도 없다** — 있던 일일 새로고침 잡
    (`preview-db.sh`)은 2026-08-13 온디맨드 전환에서 제거했다. 프리뷰를 닫아둔 밤에도 DB
    컨테이너를 매일 되살려, "안 쓰는 동안 프로덕션 사본이 디스크에 없다"는 온디맨드의 목적을
    정면으로 무너뜨리기 때문이다(재구축은 이제 `preview.sh up` 이 열 때마다 한다).
    ⛔ **그 줄을 "복원"하지 말 것** — 프리뷰를 대상으로 하는 잡은 이 파일에 다시 넣지 않는다.
    🪤 활성 앱 크론 개수는 앵커를 붙인 `grep -cE '^[0-9*].*run-cron\.sh'` 로 센다 — 앵커를
    빼면 `run-cron.sh` 를 언급하는 **주석 줄까지 세어** 활성 잡보다 큰 수가 나온다(앵커 없는
    명령을 런북에 적어 오너가 개수 불일치로 오독한 실측이 있다, 2026-08-13).
    ⚠️ **그 개수를 문서·스크립트에 고정 숫자로 적지 말 것** — 크론은 늘어난다(2026-08-13
    에 15→16). 기대값의 정본은 `infra/selfhost/crontab` 파일이고 `cutover.sh` 는 거기서
    센다(`expected_cron_count`). 종전 서술 "= **15**"는 그 이유로 SUPERSEDED.
  - ⚠️ **`deploy.sh` 는 crontab 을 재설치하지 않는다.** 크론을 추가·변경한 PR 이 머지돼
    `git pull` 이 돌아도 설치본은 그대로다 — 그 기계에서 `crontab infra/selfhost/crontab`
    을 다시 돌려야 발화한다(절차·검증 명령은 `infra/selfhost/README.md` 「앱 크론」).
    이것이 **레인 이관 후 새로 생긴 사각**이다: 레포에만 넣으면 프로덕션에서는 한 번도
    안 도는데 레이더는 예정 시각을 표시한다 — `cron-jobs.contract.test.ts` C6 가 레포 쪽
    누락을 막지만, 기계에 설치하는 것은 사람 몫이다.
    같은 사각이 위 프리뷰 줄 **제거**에도 걸린다 — 🪤 그 미재설치 구간에서 `preview.sh
    status` 는 여전히 "down" 이라고 답한다(상태 SSOT 가 컨테이너가 아니라 plist 라서,
    05:30 잡이 되살려 놓은 DB 컨테이너를 세지 않는다).
  - ⛔ **프리뷰라고 인증 우회 레인을 열지 않는다.** `DEV_AUTH_BYPASS` 는 `NODE_ENV=development`
    전용이라 빌드된 프리뷰에서 애초에 안 열리고, `AGENT_BYPASS_TOKEN` 은 셀프호스트에 넣지
    않는다(오너 확정). 프리뷰 `.env` 에도 `VERCEL_ENV=production` 을 그대로 둔다. 외부인
    차단은 프로덕션과 **같은 인가 게이트**(`src/lib/auth-allowlist.ts`)가 담당한다 —
    프리뷰 DB 에 셀러 실명·주민등록번호 암호문·매출이 그대로 들어 있기 때문이다.
  - 🪤 **운영 Supabase 스택의 컨테이너를 재생성할 때 `--no-deps` 를 빠뜨리지 말 것.**
    `auth` 는 `depends_on: db` 라서 `docker compose up -d --force-recreate auth` 는
    **`supabase-db` 까지 재생성한다**(프로덕션 DB 컨테이너다). 프리뷰 origin 을 GoTrue
    허용목록에 넣을 때 실제로 밟을 뻔한 경로다. 또한 **`docker compose restart` 는 새 `.env`
    를 읽지 않는다** — 환경변수 교체는 `up -d --force-recreate --no-deps <서비스>` 로 하고,
    실행 후 컨테이너 ID 가 그 서비스만 바뀌었는지 확인한다.
  - 🪤 **프리뷰 DB 스크립트는 프로덕션과 같은 docker 데몬을 조작한다.** 최악 사고는
    `docker rm -f supabase-db` 가 나가는 것이다 — `preview-db.sh` 의 이름 가드와
    `scripts/__tests__/preview-db.test.ts`(파괴적 `docker rm|stop|kill` 줄에 프로덕션
    컨테이너 이름이 등장하면 실패)가 그 경로를 막는다. 완화는 오너 승인 사안이다.
    같은 계약이 `preview.sh` 에도 걸린다(`preview-control.test.ts`) — 이쪽은 **launchctl
    `bootout` 이 프로덕션 라벨을 잡는 사고**까지 막는다(bootout 은 서비스 정의를 제거해
    KeepAlive 로도 복구되지 않는다).
  - 🪤 **데이터 전용 백업 복원은 `postgres` 롤로 안 된다.** `backup.sh` 의 덤프는
    `--disable-triggers` 로 만들어지는데 이 Supabase 이미지에서 `postgres` 는 superuser 가
    아니라 `permission denied: "RI_ConstraintTrigger_..." is a system trigger` 로 죽는다 —
    `supabase_admin` 으로 복원한다(`restore-drill.sh` 가 같은 이유로 그렇게 한다).

- **작업 배칭 — 지금 아끼는 것은 "승격(빌드) 횟수"이지 머지 횟수가 아니다
  (2026-08-01 정정):** 연관된 사소한 수정은 하나의 워크트리에 누적해 한 PR 로
  보낸다(AGENTS.md 「작업 병합 원칙」). 다만 **그 이유가 무엇인지를 현행 레인 기준으로
  고정해 둔다** — 근거를 잘못 알면 규칙이 과하게(또는 헐겁게) 적용된다.
  - **절약 대상은 승격 1회 = 빌드 1회다.** `main` 머지는 Vercel 배포를 만들지 않으므로
    (`deploymentEnabled.main: false`, 위 Two Projects 항목) 머지를 아끼는 것은 아무것도
    절약하지 않는다. 승격은 그때까지 쌓인 머지 전부를 빌드 1회에 싣기 때문에, 배칭의
    실효는 자동 승격 문턱(≥5건 / 4h)이 이미 구조적으로 확보하고 있다.
  - **문서 전용 변경의 단독 PR 은 운영 빌드를 유발하지 않는다 — 다만 공짜도 아니다
    (2026-08-26 정정).** ⛔ 종전 서술 *"비용은 그 PR 의 `release-preflight` 1회뿐이고,
    **레포가 public 이라 Actions 분은 무제한 무료다**"* 는 **SUPERSEDED** — 2026-08-26
    비공개 전환으로 Actions 가 **계량되기 시작했다**(AGENTS.md Project Identity).
    실측 단가는 PR 1건당 약 **13~18분**이다: `release-preflight` 가 **병렬 2잡**
    (`preflight` 261~379초 + `test` 540~563초)이고 billable 은 잡별 올림 합이라
    벽시계 소요보다 크다. 여기에 `migration-guard` 1분이 더 붙는다. Free 플랜
    포함분은 월 2,000분이므로 **단독 문서 PR 하나가 월 한도의 약 1%** 다.
    ⚠️ **단가만 보면 여유로 읽히지만 총량은 이미 한도의 약 4배다** — PR 외에 main
    push 의 `release-preflight` 와 `promote-auto` 가 따로 붙기 때문이다(2026-08 1~26
    청구 원장 실측 6,670분 / 한도 2,000분). 「월 100건까지 괜찮다」로 읽지 말 것 —
    이 오독이 실제로 「월 250건 여유」라는 오판을 낳았다(2026-08-26).
    ℹ️ **같은 날 하이브리드 CI 전환으로 `release-preflight` 는 자가호스트 러너로
    옮겨져 평시에는 계량되지 않는다**(아래 「Self-Hosted Preflight Runner」) — 위
    단가·총량 수치는 폴백으로 GitHub 러너에 돌아와 있는 동안의 판단 근거로 유지한다.
    ⚠️ **그래도 「단독 문서 PR 을 올려도 된다」는 허용은 그대로다**(오너 재확인
    2026-08-01) — 바뀐 것은 그 허용의 *근거 중 하나*(공짜)이지 허용 자체가 아니다.
    비용을 이유로 문서 PR 을 대기시키려면 **오너 재확인이 필요하다**. 잔여 분은
    메뉴바 `actionsQuota` 행에서 본다(설계 정본
    `docs/private/specs/2026-08-14-menubar-server-control-design.md` 개정 3).
    ⛔ 종전 근거 *"런타임 산출물이 안 바뀌는 변경은 main 머지가 곧 운영 빌드 1회이고,
    빌드가 프리렌더로 실 DB 를 읽어 아무 이득 없이 `P1001` 실패 확률만 한 번 더 뽑는다"*
    (오너 확정 2026-07-23)는 **SUPERSEDED** — 그 하루 뒤 2026-07-24 승격 레인 전환으로
    전제(머지=빌드)가 소멸했다. 낡은 근거로 문서 PR 을 무기한 대기시키지 말 것
    (오너 재확인·단독 문서 PR 승인 2026-08-01).
  - **그래도 배칭이 유용한 국면은 남는다:** 리뷰 단위를 의미 있게 묶는 것, 승격 배치가
    커질 때 롤백 단위를 예측 가능하게 두는 것. 이건 비용이 아니라 **가독성·복구성** 논거다.
  - ⛔ **`ignore-build` 에 경로 필터를 넣는 안은 기각 상태를 유지한다** — 정상 스킵이
    `Canceled by Ignored Build Step` 을 오염시켜 #68~#72 형 **미배포 사고의 탐지 신호를
    죽인다**(위 Two Projects 항목의 실사고).

- **PR Body Must Use the Template:** `.github/PULL_REQUEST_TEMPLATE.md`의
  `- [x] 배포 지침 및 검증 로그 확인 완료` 체크 항목을 release-preflight가
  PR 본문에서 grep으로 강제한다(누락 시 5초 만에 fail — 빌드 전 단계라
  flaky가 아니라 결정론적 게이트). `gh pr create --body "..."`처럼 본문을
  직접 넘기면 템플릿이 적용되지 않으므로 **이 문구를 본문에 직접 포함**시켜야
  한다(`gh pr create --body-file`로 템플릿을 베이스로 채우거나, 커스텀 본문
  말미에 이 줄을 그대로 추가). PR 본문만 나중에 `gh pr edit`으로 고쳐도
  release-preflight는 재트리거되지 않는다(`pull_request` 기본 트리거는
  edited를 안 잡음) — 본문 수정 후에는 커밋을 하나 push해 synchronize
  이벤트로 재실행시킨다.

- **Merge & Promote — 오너가 지목해 지시하면 실행한다 (2026-08-01 실측으로 정정):**
  기본값은 그대로다 — 에이전트는 **스스로 판단해 머지·승격하지 않는다.** 대상을
  직접 고르는 것이 금지의 핵심이다. 리뷰 반영·검증·PR 본문까지 실행 직전 상태로
  준비해 두고 인계하는 것이 평상시 동작이다.
  - **오너가 그 PR 을 지목해 지시하면 실행한다**("체크 통과하면 #213 머지해줘"
    같은 조건부 지시 포함). 오너가 지시했는데 규칙을 들어 되돌려보내지 않는다.
  - **실행 전 확인 3가지:** ① required 체크(`guard`·`preflight`·`test`)가 전부
    pass ② PR 제목에 `#NN ` 프리픽스가 있다(squash 제목 = Vercel 배포 행 이름이라
    머지 후 편집은 무효) ③ base·head 브랜치가 의도한 것이다.
  - **실행 경로:** `gh pr merge <N> --squash` 는 전역 PreToolUse 훅
    `~/.gemini/config/hooks/deploy-guard.sh` 에 **한 번 막힌다.** 이것은 거부가 아니라
    체크리스트 주입이다 — 훅이 요구하는 3항목(ⓐ 커밋에 실DB 미적용 마이그레이션이
    없는가 ⓑ drop-check: base 가 fresh `origin/main` 인가 ⓒ `git show --stat` 으로
    타 세션 파일 혼입이 없는가)을 **실제로 확인한 뒤** 명령 앞에 `GATE_OK=1 ` 을
    붙여 재실행한다. 확인 없이 마커만 붙이는 것은 이 게이트를 형해화한다.
  - ✅ **훅이 발동했다면 그것은 진짜 명령이다 (2026-08-01 오탐 수정 후).** 종전 훅은
    명령 문자열 전체를 grep 해서, 커밋 메시지·PR 본문·테스트 픽스처에 머지 명령이
    **문자열로** 들어가기만 해도 발동했다(하루에 3회 실측). 이제 heredoc 본문을
    걷어내고 실행되는 명령 줄만 본다 — 그래서 **"어차피 오탐이겠지"라며 마커를
    습관적으로 붙이면 안 된다.** 열린 heredoc 이 안 닫히면 걷어내지 않고 원문으로
    판정하므로(fail-safe) 미탐 쪽으로는 열리지 않았다. 훅은 전역 파일이라 이
    레포 PR 에 실리지 않는다(백업 `deploy-guard.sh.bak_20260801_heredoc`).
  - **승격에는 별도 게이트가 붙는다 — 요구 항목이 머지와 다르다 (2026-08-01 신설).**
    종전 훅은 "main 반영 = prod 배포"를 전제해(2026-07-12 작성) **겨냥한 지점과 실제
    위험 지점이 어긋나 있었다**: 빌드를 만들지 않는 `gh pr merge` 는 막고, **진짜 prod
    배포인 `promote-prod.sh` 는 통과**했다(실측 — 4건을 승격하는데 게이트 무발동).
    이제 승격 레인(`promote-prod.sh` · `release`/`demo` refspec push)이 따로 잡히고
    요구하는 것은 ① `--check` 로 **무엇이 나가는지** 먼저 읽고 **검증이 끝나지 않은
    사용자 대면 변경**이 있으면 멈춘다 ② 마이그레이션 동반 여부 ③ 승격 후 **SHA 기준**
    재조회다. `--check`·`--dry-run` 은 조회라 막지 않는다 — 막으면 마커가 의례가 되어
    게이트가 죽는다. 레인 이름은 **refspec 자리에서 끝날 때만** 잡는다(경계 없이 잡으면
    `claude/release-notes-fix` 같은 브랜치명이 오탐된다 — 실측).

  🪤 **분류기가 막는 것은 "머지 실행"이 아니라 "룰 문서를 고쳐 내 권한을 넓히는 것"
  이다 (실사고 2026-08-01, 한 사이클 낭비).** 종전 서술 *"권한 분류기가 차단, **채팅
  승인으로도 우회 불가**"* 는 **오진이었다.** 그 문장을 근거로 오너의 머지 지시를 두 번
  되돌려보냈고, 규칙을 고쳐야 실행할 수 있다고 판단해 P6·`CORE.md` 수정을 시도했다가
  둘 다 분류기에 막혔다. 그리고 그것을 "머지도 막혀 있다"의 방증으로 읽었다. 실제로는
  **`gh pr merge` 를 한 번도 시도하지 않은 상태**였고, 시도하자 위 훅 절차만 거쳐
  통과했다(#213, 머지커밋 `a47524c`).
  - **일반화:** 권한이 있는지 모르겠으면 **문서를 고치기 전에 그 행위를 직접 시도**한다.
    문서는 권한을 만들지 않는다 — 실행 계층이 정본이고 문서는 그것을 기술할 뿐이다.
    "규정부터 고쳐야 한다"는 판단이 서면 그 순간이 오진 의심 지점이다.

  ⚠️ **훅 메시지의 "머지 = 곧 prod 배포"는 낡았다.** 그 문구는 2026-07-12 작성 시점의
  레인(main 머지 = 자동배포)을 전제하는데, 2026-07-24 승격 레인 전환으로
  `deploymentEnabled.main: false` 가 되어 **머지는 빌드를 만들지 않는다**(위 Two
  Projects 항목). 훅의 3항목 확인은 여전히 유효하지만(마이그레이션·drop-check·커밋
  오염은 머지 자체의 위험이다), 긴급도 판단을 그 문구에 맞추지 말 것 — prod 반영은
  승격 시점이다. 훅 문구 수정은 전역 파일 소관이라 별도 사안이다.

- **PR & Commit Naming:** 커밋·PR 제목은 `type(scope): 한글 요약`(영문 제목
  금지 — 레인 불문). PR은 squash 머지를 전제한다(레포 설정이 squash 전용을
  강제 — merge/rebase 비활성 + `squash_merge_commit_title=PR_TITLE`으로 PR
  제목이 그대로 배포 이름이 되게 함). ⚠️ **이 병합 정책은 레포 이관 시 GitHub
  기본값(merge commit·rebase 허용)으로 리셋된다** — 신 `wagcrm`이 그렇게 태어나
  PR #1·#4·#5·#6이 merge commit으로 머지돼 Vercel 배포 이름이
  `Merge pull request #N from <branch>`로 찍힌 실사고가 있었다. 이관·신규 레포
  생성 직후 재적용: `gh api -X PATCH repos/<owner>/<repo> -F
  allow_merge_commit=false -F allow_rebase_merge=false -f
  squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK`.
  **PR 생성 직후, 번호가
  확정되는 즉시** 제목 앞에 `#NN ` 프리픽스를 붙인다:
  `gh pr edit <N> --title "#<N> type(scope): 한글 요약"`.
  프리픽스는 **오너가 머지하기 전에** 붙어 있어야 squash 커밋 제목(=Vercel
  대시보드의 Production 배포 행)에 실린다 — 머지 후 편집은 무효다. 이것은
  Vercel에서 배포 행을 식별하기 위한 오너 확정 규약이다. GitHub이 말미에
  붙이는 `(#NN)`은 긴 한글 제목에서 truncation으로 잘려 보이지 않으므로
  앞머리가 필수다.

- **Deployment Verification — prod 반영 판정은 셀프호스트 배포 마커다 (2026-08-18 정정):**
  에이전트의 메모리나 문맥에 의존한 지레짐작(Hallucination) 성공 보고는 금지되며, 반드시
  도구 반환값을 근거로 삼는다(P0). 커밋 메시지의 "배포완료" 주장과 과거 보고는 신뢰하지
  않는다. 판정은 **두 단계**이고, 두 단계가 보는 곳이 서로 다르다:
  - **① 코드 통합** = `git fetch` 후 `main` 포함 여부(`git merge-base --is-ancestor`).
  - **② prod 반영** = **셀프호스트 배포 마커의 조상 여부**. 마커는 `deploy.sh` 가
    **헬스체크까지 전부 성공한 뒤에만** 기록하므로(`infra/selfhost/deploy.sh` — 빌드가
    깨지면 갱신되지 않는다) "지금 서빙되는 커밋"의 SSOT 다.

    ```bash
    git merge-base --is-ancestor <머지커밋> "$(cat ~/selfhost/logs/deployed.sha)" \
      && echo "prod 반영됨" || echo "아직 서버에 없음"
    ```

    ⚠️ **마커는 프로덕션 호스트에만 있다.** 클라우드 세션·fresh clone 에 없는 것은
    고장이 아니라 정상이고, 그때 ②는 **판정 불가**이지 미배포가 아니다 — 없는 것을
    미배포로 보고하면 멀쩡한 기능에 재착수가 걸린다(P0 환각 보고의 반대 방향).
    레인마다 파일이 갈린다(프로덕션 `deployed.sha` / 그 외 `deployed.<라벨끝>.sha`) —
    ⛔ 프리뷰 마커를 집지 말 것: 프리뷰도 `main` 을 추종해 SHA 가 그럴듯해 보인다.

  머지됐는데 prod 에 없는 것은 **정상**이다(배포는 수동 발화 — 메뉴바 릴리스 섹션 또는
  `infra/selfhost/release-deploy.sh`). 버그로 오인해 재작업하지 말 것.

  ⛔ **종전 기준 "prod 반영 = `release` 포함 여부"는 SUPERSEDED**(2026-08-13 자체호스팅
  컷오버로 전제 소멸 → 2026-08-18 정정). `release` 는 **롤백 창구라 전진하지 않으므로**
  그 기준은 컷오버 이후 머지분을 **전부 미배포로 판정한다.** 실측(2026-08-18): 이미
  prod 에 배포된 PR #407 에 `scripts/await-promotion.sh --check --pr 407` → **exit 3
  "아직 미승격"**. 같은 결함이 `npm run board:check` 에서 먼저 드러났고, 판정을 마커로
  옮긴 순서는 `board:check`(#407) → `await-promotion.sh`(#418) 다 — **둘 다 고쳤다.**
  마지막 하나였던 `verify-deployment.sh` 는 **레인을 옮기는 대신 은퇴했다** — 그 함정은
  레인이 아니라 "SHA 를 아예 참조하지 않는다"라 성격이 달랐고, 마커로 옮긴들
  `await-promotion.sh` 가 이미 소유한 판정의 손수 사본이 될 뿐이었다(아래 🪤).

  ✅ **권고 *"머지커밋 기준으로 판정하는 `await-promotion.sh --check --pr <NN>` 을 먼저
  쓴다 — 그쪽엔 아래 🪤 의 함정이 없다"* 는 복권됐다**(#418 / 재실측 2026-08-21). 이 권고는
  2026-08-18 에 한 번 SUPERSEDED 됐었다 — 그때는 그 스크립트의 기본 판정이 `release` 편입 +
  Vercel 커밋상태였고, 컷오버로 `release` 가 멈춰 셀프호스트 prod 에 **상시 위음성**이었다
  (배포된 #407 에 exit 3). #418 이 기본 레인을 마커로 옮겨 그 전제가 사라졌다. 확인 대상이
  "내 PR 이 prod 에 있나"이면 이 스크립트가 정답이고, 판정은 위 ②의 마커 대조를 그대로
  자동화한 것이다(`--lane vercel` 을 명시할 때만 구 레인으로 간다). 상세는 아래
  「배포완료 자동통지」 항목.

  <!-- contract:await-promotion-default-lane=selfhost section=deployment-verification -->
  ↑ 이 절과 아래 「배포완료 자동통지」 항목은 **같은 사실**을 적는다. 두 절 모두 위와 같은
  기계 마커로 기본 레인을 신고하며, `await-promotion-doc-parity.contract.test.ts` 가 그 값을
  스크립트 실값과 대조한다 — **한 절만 갱신하면 테스트가 깨진다**(이번 실사고의 정확한 지점).

  ⛔ **이 절을 읽고 "레인 이관이 미결"이라 판단해 재착수하지 말 것 — 실사고 2026-08-21.**
  위 SUPERSEDED 문구가 #418 착지 뒤에도 남아 있어서, 한 세션이 **이미 끝난 이관을 다시
  발주받았다**. 문서 이관 패스(#419)가 「배포완료 자동통지」 항목만 갱신하고 이 절을
  놓쳤기 때문이다 — 같은 사실이 두 절에 흩어져 있으면 한쪽만 걷힌다. 재현용 실측(컷오버
  이후 머지분 5건 `31348df7`·`07c51486`·`a597318f`·`657f5772`·`2c742e99`):
  `--check` → **전부 exit 0** · 마커 경로를 없는 파일로 돌린 프로브 → **exit 5**(판정 불가)
  · 마커의 자손 커밋 → **exit 3**. 일반화: **"X 가 고장났다"는 조문을 만나면, "고쳤다"는
  조문이 다른 절에 따로 있는지 먼저 확인한다**(등재는 싸고 철회는 비싸서 낡은 채로 남는다).

  ⛔ **아래 🪤·곁함정 3건은 전부 「구 플랫폼(Vercel 롤백 창구) 레인」 이야기다** — 곁함정
  ⓐⓑ 는 그 레인을 실제로 올릴 때(롤백)만 유효하고 **셀프호스트 prod 판정에는 쓰지
  않는다**(위 ② 참조). 🪤 는 이제 은퇴 기록이다(도구가 아니라 교훈으로 읽는다).

  🪤 **`scripts/verify-deployment.sh` 는 "내 커밋이 실렸나"에 답하지 못했다 — 그래서
  은퇴했다 (결함 실측 2026-07-31 PR #205 / 은퇴 2026-08-21):** 이 스크립트는
  `gh api "repos/$REPO/deployments"` 응답에서 **가장 최근 Production 배포 하나**(`[0]`)를
  집을 뿐 **SHA·PR·브랜치를 전혀 참조하지 않았다**(소스 실독). 즉 답하는 질문은
  "**마지막** 프로덕션 배포가 건강한가"이지 "**내** 커밋이 실렸나"가 아니었다. 실제로 머지
  직후 실행해 `exit 0` · `success` 를 받았는데 집힌 것은 **이전 승격분**(`deploy #201.202`)
  이었다 — 생성 시각이 내 머지보다 이르다는 걸 눈치채지 못했으면 "배포 성공"으로 오보고할
  뻔했다.

  <!-- contract:verify-deployment-status=retired section=deployment-verification -->
  <!-- contract:verify-deployment-exit-codes=1 -->
  ↑ 은퇴 사실은 **이 절과 `AGENTS.md` 「No Hallucinated Verification」 두 곳**이 같은 기계
  마커로 신고하고, `verify-deployment-doc-parity.contract.test.ts` 가 그 값을 스크립트
  실상태와 대조한다 — **한 곳만 갱신하면 깨진다**(2026-08-21 실사고의 재발 방지 형태를
  `await-promotion-doc-parity` 에서 그대로 재사용했다). 종료코드 마커는 묘비가 **실제로
  내는** `exit` 집합과 대조되며, **0 이 그 집합에 들어오면 실패**한다.

  **왜 고치지 않고 은퇴시켰나(2026-08-21 판단):** ①2026-08-13 컷오버로 이 스크립트가
  조회하는 GitHub Deployments 는 **Vercel 이 만든 롤백 창구 기록**이 됐고 `release` 가
  전진을 멈춰, `[0]` 은 **2026-08-15 에 만들어진 배포 하나에 고정**됐다 — 실측
  2026-08-21: `[0].sha` = `c1b17217`(release 팁) 인데 셀프호스트 마커가 가리키는 실제
  서빙 커밋은 `17e29b50` 이었다. "틀린 질문에 답한다"를 넘어 **엿새 묵은 레코드로 매번
  같은 초록**을 준다. ②마커 기준으로 이관하면(선례 `board:check` #407 ·
  `await-promotion.sh` #418) `await-promotion.sh` 가 이미 소유한 판정의 **두 번째 손수
  사본**이 된다 — 이 레포의 반복 결함이다. ③롤백 창구 판정도 이미
  **`await-promotion.sh --check <sha|ref> --lane vercel`** 이 덮는다(실측 2026-08-21:
  `origin/release` → exit 0). **대상 SHA 를 받아 그 SHA 로 판정**하므로 위 함정이 원리적으로
  없다. 파일은 지우지 않고 **묘비**로 남겨 대체 경로를 알려주며 항상 실패한다(`exit 1`) —
  이 파일명은 여러 세션의 기억에 남아 있어서, 없애면 같은 `gh api deployments` 한 줄을
  손으로 다시 짜는 쪽으로 흐른다.

  ⛔ **묘비를 "고쳐서" 되살리지 말 것.** 되살릴 사유가 생기면 위 두 곳의 기계 마커와
  스크립트의 `VERIFY_DEPLOYMENT_STATUS` 선언을 **함께** 고쳐야 계약이 통과한다.

  **곁함정 2건 — 둘 다 반대 방향의 오판이다(멀쩡한 것을 사고로 읽는다):**
  - ⓐ **승격 푸시 직후 그 SHA 의 배포는 0건이다** — 실측 약 4분 뒤 생성됐다. 0건을 즉시
    무발화 사고(#91·#92)로 읽지 말고 폴링한다.
  - ⓑ **GitHub Deployment 의 `production_environment=false` + 해시 `wag-*.vercel.app`
    URL 은 이 레포의 정상 형태다** — 직전 정상 배포 2건과 필드·타임스탬프를 대조해
    확인했다. 배포 레코드와 status 타임스탬프가 **같은 초로 붙는 것도 정상**이다(빌드가
    끝난 뒤 레코드가 생성되기 때문).

  ⭐ **등재 이유:** P0 「No Hallucinated Verification」 은 "도구를 실행하라"까지만 말하는데
  이 건은 **도구를 실행했는데도 틀린** 경우라 그 조항만으로는 걸리지 않는다. P9(`dev-qa.md`)
  「검증 판정 위생」의 *"이 도구가 보는 범위가 무엇인가"* 와 같은 계열이다.

- **배포완료 자동통지 — `await-promotion.sh` (2026-07-24 도입 / 2026-08-19 레인 이관):**

  ✅ **레인이 둘이고 기본값은 셀프호스트다(#418).** `--check`/`--watch` 는 기본적으로
  **셀프호스트 배포 마커의 조상 여부**로 판정한다(위 Deployment Verification ②와 같은
  기준이다). 구 플랫폼(롤백 창구) 판정은 **`--lane vercel`** 로 남아 있고 그 로직은
  무수정이다 — 롤백을 실제로 올릴 때는 그쪽이 맞는 답을 준다.

  <!-- contract:await-promotion-default-lane=selfhost section=await-notify -->
  <!-- contract:await-promotion-exit-codes=0,1,2,3,4,5 -->
  ↑ 위 「Deployment Verification」 절과 짝을 이루는 기계 마커다(정합 계약 —
  `await-promotion-doc-parity.contract.test.ts`). 종료코드 마커는 스크립트가 **실제로 내는**
  `exit` 집합과 대조되므로, 코드가 늘거나 사라지면 이 목록을 함께 고쳐야 한다.

  - **추가 종료코드 `5` = 판정 불가**(마커 부재·비-SHA·git 이 모르는 SHA). ⛔ **5 를 3 으로
    접지 말 것** — 3 은 "안 실렸다"는 **주장**이고 5 는 "모른다"이다. 마커는 프로덕션
    호스트에만 있으므로 클라우드 세션·fresh clone 에서 5 가 나오는 것은 **정상**이다.
  - **`--watch` 는 판정 불가면 매달리지 않고 즉시 exit 5** 한다. 근거 없는 워처는 영원히
    깨지 않으므로, 기다리는 척하는 것 자체가 이 도구가 없애려던 실패 양식이다.
  - ⚠️ **셀프호스트 레인에는 "배포 실패" 상태가 없다.** `deploy.sh` 는 성공했을 때만 마커를
    쓰므로 실패는 "마커가 안 움직임"으로만 보여 미배포와 구분되지 않는다 — 실패를 지어내지
    않고 기다리다 타임아웃(exit 2)한다. 거짓 성공은 없다.
  - 테스트는 `AWAIT_DEPLOY_MARKER` 로 마커 경로를 갈아끼운다. ⛔ **실 마커를 덮어써서
    프로브하지 말 것** — `deploy.sh` 가 그 파일로 "변경 없음"을 판정해 프로덕션이 구버전을
    서빙한 채 재배포를 건너뛴다.

  ⛔ **2026-08-13~08-19 사이에는 이 도구가 고장나 있었다**(되짚을 때만 참고). 기본 판정이
  `release` 편입 + Vercel 커밋상태였는데 컷오버로 `release` 가 전진을 멈춰, 컷오버 이후
  머지분은 배포돼 있어도 `--check` **exit 3**, `--watch` 는 **영원히 무통지**였다(실측
  2026-08-18: prod 에 있는 #407 → exit 3). 같은 결함이 `board:check` 에서 먼저 드러났다(#407).

  머지 ≠ 배포라, PR 을 머지한 세션은 "내 커밋이 배칭 승격으로 언제
  prod 에 나갔나"를 자동으로 알 길이 없어 `gh pr checks` 를 수동 폴링해야 했다. 이제
  세션측 워처 `scripts/await-promotion.sh` 가 그 역방향 통지를 담당한다 — **배포 레인
  무접촉**(promote-auto.yml·promote-prod.sh·vercel.json 을 건드리지 않는다).
  - **대기(자동통지)**: 머지 직후 세션이
    `bash scripts/await-promotion.sh --watch --pr <NN>` 를 **백그라운드**(Bash
    run_in_background 등)로 건다. ⚠️ **아직 머지 전이면 `--await-merge` 를
    붙인다** — 안 붙이면 머지커밋이 없어 **즉시 exit 1** 이다("머지되면 배포까지
    확인해줘"가 정확히 이 경우다. 종전엔 세션마다 머지 대기 앞단을 임시
    래퍼로 새로 짰다 — 2026-07-29 하루에 세 번). 이 경우 추가 종료코드
    **4 = PR 이 머지되지 않고 닫힘**. 커밋이 prod 에 도달하는 순간 프로세스가 종료(exit 0)
    되고 하네스가 세션을 자동 재소환한다 — 수동 폴링 소멸. 승격 실패면 exit 1 로
    재소환돼 즉시 조사(`promote-failed` 이슈 참조), 시간 상한 초과면 exit 2.
    ⚠️ **에이전트 하네스의 백그라운드 Bash 에는 태우지 말 것** — 그 도구의 timeout
    상한이 10분인데 승격은 문턱 미달 시 **최대 4시간**(위 시간 상한)을 기다린다.
    워처가 배포보다 먼저 죽어 "조용한 미통지"가 된다(2026-07-29 PR #123 실측).
    세션에서 걸 때는 세션 수명만큼 사는 상주 워처로 위 게이팅 루프를 돌린다.
    `--watch` 는 **사람이 터미널을 지키는 CLI 경로**다.
  - **1회 조회(내구)**: `--check --pr <NN>`(또는 `<sha|ref>`)는 지금 상태를 즉답한다
    (**0**=실림 · **3**=아직 · **1**=오류 · **5**=판정 불가). 세션이 닫혔다 새 세션으로
    돌아와도 언제든 확정 상태를 재조회한다 — 판정은 git+커밋상태 SSOT 라 세션 생존과
    무관하다(내구 신호를 별도 인프라 없이 확보).
  - ⚠️ **exit 1 은 "승격 실패"만이 아니다 — "아직 미머지"와 겹친다**(실측
    2026-07-30, PR #150: 오픈 상태 PR 에 `--check --pr` → exit 1 + "머지되지
    않았거나 머지커밋을 찾을 수 없다"). `--watch` 뿐 아니라 `--check` 도 그렇다.
    종전 서술 "1=승격 실패"는 이 겹침을 적지 않아 **미머지 구간을 승격 사고로
    오판**하게 만든다(있지도 않은 `promote-failed` 이슈를 찾아다니게 된다).
    따라서 **`--check` 만으로 폴링하는 워처를 짜지 말 것** — 반드시
    `gh pr view <NN> --json state` 로 먼저 게이팅한다: `OPEN` 이면 조용히 대기 ·
    `CLOSED` 면 미머지 종료로 보고 · `MERGED` 일 때만 `--check` 로 넘어간다.
    머지 직후엔 로컬 git 이 머지커밋을 아직 모르는 레이스가 있으니 **비-0/비-3 은
    2회 연속일 때만** 실패로 판정한다(1회성 오탐 방지).
  - 판정 계약은 위 **Deployment Verification 2단계**를 그대로 자동화한 것이다(코드 통합=
    main 조상 / prod 반영=셀프호스트 마커 조상). `--lane vercel` 일 때만 ②가 "완료된
    `release` 커밋의 조상"으로 바뀐다 — 그 레인의 Vercel 컨텍스트 필터는
    `promote-prod.sh` 와 **동일 계약**이다(`scripts/__tests__/await-promotion.test.ts` 가
    두 스크립트를 같은 픽스처로 고정해 드리프트를 막는다).

- **`P1001` 배포 실패는 코드 결함이 아닐 수 있다 — 빌드가 DB를 읽는다 (2026-07-23):**
  ISR 표면은 **정의상 빌드 때 Prisma 로 실 DB 를 읽는다**(실측:
  `.next/prerender-manifest.json` 37 라우트 중 `/`·`/deals`·`/partners`·`/sellers`·
  `/settlement`·`/reports/pnl`·`/admin/*` 등). 그래서 Supabase 풀러가 **몇 초만
  흔들려도 무관한 커밋의 배포가 통째로 실패**한다 —
  `PrismaClientKnownRequestError` / `P1001 Can't reach database server`.
  한 페이지에서 넘어지면 `Export encountered an error … exiting the build` 로 즉시
  종료하므로 **로그에는 첫 실패 페이지 하나만 보인다** — 그 페이지가 범인이 아니다.

  **판정 순서(코드를 파헤치기 전에 이걸 먼저 — 일반 서명 "결정론적 결함은 같은
  곳에서 멈춘다"는 전역 AGENTS.md §「CI·배포 결과 판독」):**
  1. `gh api repos/indexzigu/wagcrm_git/commits/<sha>/statuses` 로 **시간순** 확인 —
     같은 커밋이 success→failure 로 바뀌었으면 나중 건은 재배포다.
  2. Vercel MCP `get_deployment` 의 `meta.action`/`source` 가 `redeploy` 면 머지
     배포와 별개 건이다(오너 수동 실행).
  3. 앞뒤 수십 초~수 분 내 **다른 커밋 배포가 성공**했으면 외부 요인 확정.
     실패 지점이 배포마다 **서로 다르면** 더 확실하다(결정론적 코드 결함이면 같은
     곳에서 멈춘다 = 외부 요인의 서명).
  4. 최신 성공 배포가 프로덕션을 서비스 중이면 **조치 불요** — 실패한 재배포는
     alias 를 가져가지 못한다.

  **실사고(2026-07-22, 두 사고가 겹쳤다):** Ignored Build Step 이 #68~#72 를 삼켜
  (위 Two Lanes 항목) 오너가 14:40~14:41 에 그 5건을 **수동 일괄 재배포**했는데,
  그중 #69(14:41:04)·#70(14:41:18) 두 건만 `P1001` 로 실패하고 30초 뒤 #71·#72 는
  성공했다. 즉 **삼켜진 배포를 복구하던 중 수십 초짜리 DB 블립을 밟은 것**이고,
  #69 코드와는 무관하다.

  **대응은 재시도이지 동적화가 아니다.** `next.config.ts` 의
  `experimental.staticGenerationRetryCount: 2`(#75)가 순간 장애를 흡수한다.
  ⚠️ **`await connection()` 을 뿌려 ISR 표면을 동적으로 바꾸지 말 것** — 캐시를
  버리는 것이라 egress·Fluid CPU 를 되돌리고 `cache-policy.ts`(SSOT)와 충돌한다.
  `getCachedChannelFeeConfig` 처럼 "쓰기가 태그를 즉시 깬다"는 근거로 긴 cacheLife 를
  택한 표면들이 있어, 동적화는 신선도 이득도 없다(이 세션이 실제로 그 오판을 했다가
  코드 주석을 읽고 되돌렸다). 재시도는 **가려서는 안 되는 실패는 가리지 않는다** —
  장기 DB 장애는 그대로 빌드 실패로 드러난다.

  ⚠️ **로컬에서 `npm run build` 를 그대로 돌리지 말 것** — 첫 단계가
  `scripts/prisma-migrate-on-deploy.mjs`(프로덕션 DB 마이그레이션)다. 라우트 표만
  확인할 목적이면 `npx next build` 로 그 단계를 건너뛴다(읽기 전용 프리렌더).
  프리렌더 여부의 정본은 빌드 로그의 `○`(Static) vs `◐`(PPR) 마커와
  `.next/prerender-manifest.json` 의 `initialRevalidateSeconds` 다.

- **Shared Tree Hygiene:** 규율 정본은 전역 `~/.gemini/config/AGENTS.md`
  §「Shared-Tree Hygiene」이다(2026-08-01 승격) — `git add -A` 일괄 스테이징
  금지(경로 명시 — 타 세션 미완성 코드 동반 커밋 방지) · 인자 없는
  `git stash pop`/`drop` 금지(stash 스택은 저장소 전체 공유 — `git stash list` 로
  내 항목을 확인하고 인덱스 명시) · 브랜치 전환은 stash 대신 워크트리 추가.
  이 레포의 실사고: 2026-07-24 인자 없는 pop 이 타 세션 stash(`stash@{0}`)를
  현재 트리에 쏟아 `UU` 충돌 — `git reset --hard` 로 복구했고 stash 는 보존됐다.

- **⛔ 추적 파일을 메인 레포에서 편집·커밋하지 말 것 — 모드 L 습관이 타 세션
  브랜치를 오염시킨다 (실사고 2026-07-31):** 워크트리 세션은 **두 곳을 오간다** —
  보드·로그(`PROJECT_MASTER.md`·`PROJECT_LOG.md`)는 모드 L 이라 **메인 레포 루트의
  단일 사본**을 편집해야 하고(AGENTS.md 문서 관리 정책), 코드·문서 같은 **추적
  파일은 자기 워크트리**에서 편집해야 한다. 이 둘을 한 세션에서 섞으면 사고가 난다.
  - **실사고:** 보드를 정리하느라 `cd <메인레포> && …` 를 반복하던 흐름 그대로
    `docs/agents/*.md` 를 편집하고 커밋했다. 메인 레포는 그때 **다른 세션의 브랜치**
    (`claude/old-repo-pr-number-trap`)에 있었고, 커밋이 **그 브랜치 위에** 쌓였다.
    내 워크트리에서 만든 브랜치는 빈 채로 push 돼 **PR 이 사실상 비어 있었다.**
    그대로 뒀으면 타 세션 PR 에 내 문서 변경이 섞여 들어갔다.
  - **왜 눈에 안 띄나:** `git checkout -B` 는 **명령을 실행한 트리**에서 일어난다.
    워크트리에서 브랜치를 만든 뒤 편집만 메인 레포에서 하면, 브랜치는 내 것인데
    **작업물은 남의 브랜치에 있는** 어긋난 상태가 되고 둘 다 성공 메시지를 낸다.
  - **규칙:** 추적 파일을 건드리기 전에 **작업 디렉터리가 자기 워크트리인지** 확인한다
    (`pwd` · `git rev-parse --abbrev-ref HEAD`). 메인 레포 `cd` 는 **모드 L 파일 편집에만**
    쓰고, 그 명령 안에서 `git add`/`git commit` 을 하지 않는다.
  - **탐지:** 커밋 직후 출력의 `[브랜치명 sha]` 를 읽는다 — 내 브랜치명이 아니면 즉시 멈춘다.
    push 가 "new branch" 인데 원격에 내 커밋이 없으면 같은 증상이다.
  - **복구(브랜치 전환 없이):** ①내 워크트리에서 `git cherry-pick <내 커밋>` 으로
    `origin/main` 위에 다시 얹는다 ②메인 레포 트리가 **클린인지 확인**한 뒤
    `git reset --hard <타 세션 원격 tip>` 으로 되돌린다 ③타 세션 브랜치가 원격과
    **완전 일치**하는지 해시로 확인한다. ⚠️ 트리가 더러우면 리셋하지 말 것 — 그 세션의
    미커밋 작업이 날아간다.

- **Push 전 브랜치명 1회 확인 (2026-07-31 실사고, P0 연장):** `git push` 하기 전에
  `git rev-parse --abbrev-ref HEAD` 로 브랜치명을 **읽는다**. 브랜치명은 push 순간
  원격에 남아 PR 페이지·`git ls-remote` 에 드러난다. ⚠️ **2026-08-26 비공개 전환
  후에도 이 절차를 그대로 유지한다** — 사유는 AGENTS.md P0 Public Repo Data Guard
  가 정본이다(공개 기간의 이력은 이미 나갔고, 가시성은 되돌릴 수 있는 **설정**이다). 하네스는
  **세션 제목에서 브랜치명을 자동 파생**하므로 제목에 셀러 실명·실측치가 있으면
  손대지 않아도 브랜치로 샌다 — 실제로 셀러 실명을 로마자로 담은 브랜치가 생성됐고
  push 직전에 발견해 개명했다(원격 유출 0). 실명이 섞였으면 `git branch -m <새이름>`
  으로 **push 전에** 고친다(이미 push 했다면 새 이름으로 push 후 원격 구 브랜치 삭제).
  ⚠️ **`commit-guard` 는 이 경로를 구조적으로 못 잡는다** — 아래 항목대로 그 가드는
  **스테이징 diff 의 추가 줄과 커밋 메시지만** 보고 브랜치명(=ref 이름)은 입력에
  들어가지도 않는다. 즉 현재 탐지는 **사람 눈뿐**이다. 가드를 브랜치명까지 보게
  넓히는 것은 별도 판단 사안이다(패턴 완화·확장은 오너 승인 사안 — 미결).

- **Commit Guard — 커밋 게이트(pre-commit·commit-msg, 2026-07-29):**
  `scripts/commit-guard.mjs`가 **스테이징 diff의 추가 줄**과 커밋 메시지를
  스캔해 시크릿(API 키 형태·URL 내장 자격증명·개인키 블록·장기 JWT·시크릿
  env 리터럴 대입)·주민등록번호 형태·비허용 이메일·`.env` 파일 스테이징을
  차단한다. `npm install`의 `prepare`가 `core.hooksPath=.githooks`를 설정해
  활성화된다(수동 점검은 `npm run guard:commit`). 추가 줄만 검사하므로 기존
  코드는 소음을 내지 않고, 허용목록은 줄이 아니라 **매치 토큰 단위**로만
  면제한다. 셀러 실명·실측치처럼 public 레포에 패턴 자체를 못 넣는 금지어는
  `.git/info/commit-guard-denylist`(미추적 — 전 워크트리 공용)에 한 줄씩
  추가한다. 검출 계약은 `scripts/__tests__/commit-guard.test.ts`가 고정하며
  패턴 완화는 오너 승인 사안이다. 의도적 예외만 `git commit --no-verify`로
  우회하고 사유를 PR 본문에 남긴다. 역할 분담: 소스 리터럴 폴백 키는
  `hardcoded-secret-literals.contract.test.ts`, 커밋 시점 유입은 이 게이트.

- **Prod Migration Protocol — 배포 시 자동 적용(모델 B):** 신규 Prisma
  마이그레이션은 프로덕션 배포 시 자동 적용된다. `build` 커맨드 맨 앞의
  `scripts/prisma-migrate-on-deploy.mjs`가 `VERCEL_ENV==='production'`일 때만
  `prisma migrate deploy`를 실행해, 새 코드가 트래픽을 받기 전에 대기 중
  마이그레이션을 선적용한다. 실패 시 build가 실패해 배포가 중단된다(fail-safe
  — 기존 코드 유지). 로컬 `npm run build`·Vercel preview·release-preflight
  (모두 `VERCEL_ENV` 미설정)에서는 자동 skip → 실 DB 무접촉. **Vercel
  production env에 `DIRECT_URL`(세션 모드, 5432 직결/세션 풀러) 필수** —
  트랜잭션 풀러(6543/`pgbouncer=true`)로는 migrate deploy가 세션 락을 못 써
  실패한다(스크립트가 선제 차단). 스키마 변경은 로컬 `prisma migrate dev`로
  마이그레이션을 생성해 `schema.prisma`와 동기 상태로 커밋하는 것이 한
  단위다(수동 멱등 SQL 작성 + `db execute` 오너 인계 모델은 이 자동 적용으로
  대체됨).

- **✅ preflight는 일회용 Postgres로 빌드한다 — 프로덕션 DB를 쓰지 않는다
  (2026-08-13 전환):** `release-preflight.yml`이 `services: postgres`(PG 17)를
  띄우고, `npx prisma migrate deploy`로 스키마를 먼저 적용한 뒤 `release:check`를
  돌린다. 아래 두 고질과 자체호스팅 이관의 차단 요인이 **함께** 닫혔다:
  - **`P2022`** — ISR이 읽는 테이블에 컬럼을 추가해도 이제 임시 DB에 마이그레이션이
    선적용되므로 막히지 않는다. "오너 승인 후 프로덕션에 선적용" 우회가 불필요해졌다.
  - **`P1001`** — 빌드가 실 DB를 읽지 않으므로 풀러 블립으로 무관한 PR이 실패하는
    경로가 사라졌다(위 P1001 항목은 **Vercel 프로덕션 빌드**에는 여전히 유효하다).
  - **클라우드 강등 차단** — preflight는 required 체크라, 이관 후 Supabase를
    강등·일시정지하면 모든 PR이 막힐 상태였다.
  - 대가: 프리렌더가 **빈 DB**로 렌더된다. 이 게이트의 목적("빌드가 성립하는가")에는
    충분하고, 실 데이터 렌더 검증은 자체호스팅 배포(`deploy.sh`)가 한다.
  - 실측(2026-08-13): 빈 임시 Postgres + **도달 불가 Supabase 주소**로도
    `release:check`가 통과했다 — 빌드는 Supabase HTTP에 의존하지 않는다.
  - `DATABASE_URL`·`DIRECT_URL`은 `requiredCiSecrets`(`scripts/release-config-shared.ts`)
    에서 제거됐다 — 시크릿이 아니라 워크플로 안의 리터럴이다. 되돌리면
    `verify:release-config`가 "missing required CI secret mapping"으로 실패한다.
  - 같은 날 `verify:vercel-auth`도 `release:check` 체인에서 제거했다(스크립트 삭제).
    특정 Vercel 계정·팀 로그인을 요구하는 로컬 전용 검사였는데, 배포가 자체호스팅으로
    옮겨져 역할이 끝났고 Vercel 해지 시 로컬 `release:check`를 막게 된다.

  ⛔ 아래는 **2026-07-29~2026-08-13 사이의 상태**다 — 그 시절 실패를 되짚을 때만 참고할 것:

  > `release-preflight.yml`은 `secrets.DATABASE_URL`,
  > 즉 **프로덕션 DB로 빌드**한다. 그런데 build 맨 앞의
  > `prisma-migrate-on-deploy.mjs`는 `VERCEL_ENV` 미설정이라 skip되므로,
  > 새 컬럼은 DB에 없는 채 ISR 프리렌더가 새 스키마로 SELECT → `P2022 The
  > column X does not exist`. **코드 결함이 아니다** — 실제 배포는 migrate가
  > 먼저 돌아 정상이고, preflight에서만 난다.
  > - 첫 사례는 `Deal.category`(#120). 그 전 ADD COLUMN들이 멀쩡했던 이유는
  > OrderCampaign·NaverOrderSnapshot·Notification 등 **빌드 때 읽히지 않는**
  > 모델이었기 때문이다. 즉 문제는 "컬럼 추가"가 아니라 "**ISR 프리렌더가
  > 읽는 테이블**의 컬럼 추가"다(대상 판별은 위 P1001 항목의 프리렌더 목록 참조).
  > - **대응(현행): 오너 승인 후 프로덕션에 선적용.** additive 마이그레이션은
  > expand-and-contract의 정석이라 안전하다 —
  > `set -a; . <메인레포>/.env; set +a; npx prisma migrate status`로 대기분을
  > 확인(워크트리엔 `.env`가 없다) → `npx prisma migrate deploy` → preflight
  > 재실행. 배포 시 재실행은 멱등이라 no-op. 적용 후 기존 행 수를 실측해
  > 보존을 확인한다(#120에서 Deal 140건 보존 확인).
  > - 근본 해결은 preflight를 임시 postgres(`services:`)로 돌려 빌드 전
  > `migrate deploy`하는 것이다. P1001(프로덕션 DB 블립으로 무관 PR이
  > 실패하는 문제)도 같이 닫히지만 배포 레인 변경이라 별도 PR·검증이 필요하다
  > — **미결 과제**.

- **⛔ Self-Hosted Preflight Runner 는 이 레포에서 은퇴했다 (2026-08-28, 공개 레포
  이전과 함께):** 아래 절 전체는 **구 레포(`indexzigu/wagcrm`) 시절의 기록**이며,
  좌표·명령은 그 레포를 가리킨다. 이 레포는 **전 잡을 GitHub 러너로 돌린다.**
  - **왜 되돌렸나:** 자가호스트는 비공개 무료 한도(월 2,000분, 실사용 약 8,000분)를
    피하려고 만든 것이다. **공개 레포는 GitHub 러너가 무제한 무료**라 그 이유가
    통째로 사라졌다.
  - **⛔ 다시 붙이지 말 것 — 공개 레포에서는 보안 사안이다.** 포크에서 올린 PR 이
    테스트 코드를 바꿔 그 러너에서 임의 코드를 실행할 수 있고, 그 러너는 프로덕션
    DB·셀프호스트 스택이 있는 오너의 맥 안에 있다. 붙이려면 외부 기여자 워크플로
    승인제 + 포크 PR 을 자가호스트로 보내지 않는 조건이 **함께** 필요하다.
  - **실측 비교(2026-08-28):** 자가호스트 = 큐 평균 2분·**최대 137분** + 실행 평균
    9분. GitHub 러너 = 큐 0분 + 실행 11.5분. ⚠️ **실행 자체는 GitHub 러너가 느리다**
    (2코어). 이전의 이득은 평균이 아니라 **꼬리**다 — 최악 175분이 11.5분이 된다.
  - **🪤 「러너를 업그레이드하면 되잖아」는 이미 막다른 길이다.** 병목은 메모리가
    아니라 **호스트의 물리 6코어**다(iMac20,1 · i5-10600 · 32GB). VM 에 CPU 8 을 준
    시도는 실패해 4로 되돌렸고(T-070), 러너 3대 동시는 빌드를 5분35초 → 22분으로
    늘려 기각됐다. 러너를 늘려도 **총 처리량은 VM 에 준 vCPU 로 고정**이라 큐가 준
    만큼 실행이 느려진다. GitHub 러너는 PR 마다 별도 머신을 받는다 — 한 대짜리
    호스트가 구조적으로 못 따라가는 지점이다.
  - **OOM 대비는 이미 돼 있다** — 상한 인상이 아니라 스왑 2GB + 자동 재기동이라는
    오너 결정(아래 「넘쳤을 때의 자가복구」)이 그대로 유효하다. VM 은 이제 CI 가
    아니라 셀프호스트 스택 전용이므로 압력이 오히려 내려간다.

  <!-- 아래는 구 레포 기록 — 보존하되 이 레포에 적용하지 않는다. -->
  구 레포에서는 비공개 전환으로 Actions 가
  월 2,000분으로 계량되는데 소모의 90%+ 가 이 워크플로였다(계량 실측은 위 「작업 배칭」
  항목). `preflight` 는 required 체크라 분이 소진되면 **전 PR 머지 불가**가 되므로,
  최중량 워크플로 하나만 자가호스트로 옮겨 잔류 소모를 한도의 ~25%로 내렸다.
  - **하이브리드 분담이 의도다 — 전량 이전으로 넓히지 말 것.** `migration-guard` ·
    `promote-auto` · `daily-db-backup` 은 GitHub 러너에 남긴다. promote-auto 는 머지를
    prod 로 미는 잡이라 맥 러너가 죽어도 살아 있어야 하고, guard 가 남아야 러너 장애
    중에도 마이그레이션 검증이 유지된다.
  - **러너는 Colima VM 안(Linux)에 산다** — `preflight` 잡의 `services: postgres` 가
    Linux 러너 전용이라 호스트 macOS 에 설치하면 이전 자체가 무의미하다. VM 은
    프로덕션 Docker Desktop 과 **완전 분리**된 별도 VM(docker context `colima`)이고
    한도는 CPU 4 · 메모리 8GB · 디스크 30GB 다(잡 1개 빌드 피크 ≈3.7GiB · 잡 2개 동시
    실행 시 VM 사용 피크 6.0GB 실측 2026-08-26).
    ⛔ **종전 값 「CPU 8」은 SUPERSEDED — 2026-08-27 에 `cpu: 4` 로 내렸다(T-070).**
    근거와 인하 전후 실측은 바로 아래 「호스트 CPU 는 물리 6코어…」 항목. 메모리 8GB 는
    **손대지 않았다** — OOM 의 처방은 상한 인상이 아니라 스왑·자동 재기동이고(아래
    「넘쳤을 때의 자가복구」), 상한은 「내줘도 되는 양」으로 정한다는 오너 결정이 그대로다.
    ⛔ **종전 서술 「활성 러너 2개 기준으로 8GB 안에 든다」는 SUPERSEDED**(2026-08-27) —
    러너 **2대 구성에서 커널 OOM 이 실제로 났다.** VM 저널 실측: `global_oom` ·
    `cpuset=…imac-colima-1` ↔ `task_memcg=…imac-colima-2` — **1번 쪽 작업이 메모리를
    요구한 순간 희생자는 2번이었다**(전역 OOM 이라 요구한 쪽이 아니라 점수가 높은 쪽이
    죽는다). 죽은 node 하나가 anon-rss 1.9GB, 시각은 15:36:12 KST.
    🪤 **커널 사건의 시각은 `journalctl -k` 로 뽑는다 — `dmesg -T` 로 인용하지 말 것.**
    그쪽 시각은 부팅 시각 + 단조 시계로 월클럭을 **재구성**한 값이라 시계가 조정되는
    VM 에서 어긋나고 **읽을 때마다 달라진다**(같은 줄이 두 조회에서 15:32:20 · 15:32:13,
    저널은 15:36:12 — 실측). 이 사고의 1차 보고가 실제로 4분 어긋난 시각을 담았고 교차
    검증에서 잡혔다. ⚠️ **오차가 「그럴듯한 크기」라 반증 계기가 안 생긴다** — 사건이
    여럿이면 엉뚱한 것과 짝지어진다. `dmesg` 는 **내용**(어느 프로세스가·얼마나)만 본다.
    여파는 잡 1건 `cancelled`(타임아웃 아님 —
    `timeout-minutes` 30 인데 5분13초에 끊겼다) + 큐 3건 정체였고, `preflight` 가
    required 라 그동안 **레포 전체 머지가 막혔다.**
    ⚠️ **6.0GB 는 관측된 피크이지 상한이 아니다** — 두 잡의 `npm ci`(잡당 ≈2GB)가 언제
    겹치는지는 PR 내용이 정하므로, 한 번 관측한 피크를 「든다」의 근거로 쓰면 안 된다.
    그날의 잡 2개 동시 실행 중 실측도 used 5,429 / available 2,508 로 여유가 얇았다.
    ⛔ 활성 러너를 3개로 늘리면 8GB 로는 여전히 부족하다: `npm ci` 만 잡당 ≈2GB 라 설치
    단계 겹침만으로 7.2GB 실측. ⚠️ "예약이 아니라 상한"이라고 읽지 말 것 — **호스트 관점에서는
    틀리다**: VM 은 상한까지 올라가 거기서 머물므로 상한이 곧 호스트에서 영구히 떼어 주는
    양이다(근거 실측은 아래 메모리 🪤 항목). 그래서 상한은 피크 작업량이 아니라 **내줘도
    되는 양**으로 정한다(16GB→8GB 인하는 오너 지시 2026-08-26).
    상시기동은 두 겹이다:
    ①VM = `brew services`(launchd KeepAlive) ②러너 = VM 안 systemd(`svc.sh`).
    설치·재등록·상태 확인 명령의 정본은 `infra/selfhost/README.md` 「GitHub Actions
    자가호스트 러너」.
  - **호스트 CPU 는 물리 6코어 · 논리 12스레드다 (Intel i5-10600, 실측 2026-08-27) —
    `cpu` 상한을 읽을 때 이 두 숫자를 구별할 것.** vCPU 는 호스트의 **논리 스레드**에
    실리므로 종전 값 `cpu: 8` 도 논리 12개 **안에** 들었다 — **물리 코어(6)보다 크다는
    것만으로 「없는 자원을 적은 값」이라고 판정하면 틀린다**(실제로 그 오독이 인하
    발주의 근거로 올라왔다). 인하의 근거와 그때 함께 봐야 할 것들은 아래와 같다:
    - **VM 안에서:** vCPU 가 전부 바빠도 물리 코어는 6개뿐이라, 상한을 6 이상으로 줘도
      그만큼의 처리량이 나오지는 않는다(하이퍼스레딩 몫만큼만 더 나온다).
    - **호스트에서:** VM 이 가져간 만큼이 호스트에서 빠진다. 종전 8 이면 남는 것이 4개,
      현행 4 면 8개다. 그 자리에서 프로덕션 앱(3000) · 프로덕션 Docker Desktop VM ·
      오너와 타 세션의 로컬 작업이 전부 돌아간다.
      **이 값의 진짜 비용은 VM 안 처리량이 아니라 호스트에 남기는 여유다** — 메모리
      상한을 「내줘도 되는 양」으로 정하는 것과 같은 기준이다(아래 메모리 🪤 항목).
    - ⚠️ **다만 CPU 와 메모리는 회수 방식이 정반대다.** 메모리 상한은 VM 이 한 번 닿으면
      호스트로 **영구히 돌아오지 않지만**(반환 통로 부재 — 아래 메모리 🪤), CPU 는 VM 이
      쉬는 동안 호스트가 즉시 되가져간다. 그래서 `cpu` 인하가 돌려주는 것은 「평시 여유」가
      아니라 **CI 가 도는 동안의 여유**뿐이다 — 두 값을 같은 근거로 함께 조정하지 말 것.
    - **`cpu` 8 → 4 인하는 실측 후 채택했다 (2026-08-27, T-070).** 대가는 **중앙값 기준
      40초대**이고, 그 대신 **최대값(꼬리)은 짧아졌다.** 자가호스트에서 성공한 잡 전수를
      인하 시점으로 가른 집계:
      | 잡 | 설정 | n | 최소 | 중앙 | 평균 | 최대 |
      | --- | --- | --- | --- | --- | --- | --- |
      | `preflight` | `cpu: 8` | 26 | 4분42초 | 5분43초 | 7분09초 | 15분49초 |
      | `preflight` | `cpu: 4` | 7 | 5분24초 | 6분28초 | 6분55초 | 10분22초 |
      | `test` | `cpu: 8` | 18 | 7분00초 | 8분42초 | 9분59초 | 18분38초 |
      | `test` | `cpu: 4` | 6 | 8분26초 | 9분28초 | 9분52초 | 13분10초 |
      같은 커밋·같은 워크플로를 VM 설정만 바꿔 재실행한 대조(경합 프로필까지 일치)에서는
      `preflight` 6분36초 → 6분35초, `test` 8분47초 → 9분26초였다.
      ⚠️ **평균이 `cpu: 4` 쪽에서 낮은 것을 「더 빨라졌다」로 읽지 말 것** — 평균을 끌어내린
      것은 꼬리이고, 꼬리는 아래 🪤 대로 **호스트 부하가 정한다**(즉 표본이 언제 찍혔는지에
      좌우되므로 설정 비교의 근거가 못 된다). 반면 **중앙값·최소값은 일관되게 `cpu: 4` 쪽이
      40~80초 느리다.** 판정에 쓸 문장은 「**대가는 40초대이고, `timeout-minutes` 30 대비
      최악 표본(13분10초)도 2배 이상 여유다**」이다.
      🪤 이 절의 초안이 실제로 **평균·최대만 골라 「분포가 바뀌지 않았다」**고 적었다가
      표본을 늘리면서 뒤집혔다 — 분포를 인용할 때 중앙값을 빼지 말 것.
    - 🪤 **잡 소요시간의 지배 변수는 VM 설정이 아니라 「그때 이 맥이 얼마나 바빴는가」다 —
      단일 전후 비교로 VM 설정의 효과를 판정하지 말 것 (2026-08-27 실측).** 위 인하
      과정에서 실제로 밟을 뻔한 오판이다: 같은 `cpu: 4` 인데 `preflight` 가 한 표본에서
      6분35초, 다른 표본에서 **10분22초**(+58%)였다. 차이는 타 세션 둘이 같은 맥에서
      작업해 호스트 15분 부하가 3.4 → **10.0** 으로 오른 것뿐이었다. 반면 `cpu` 를
      8 → 4 로 **절반으로 줄인 효과는 같은 잡에서 −1초**였다. 즉 **잡음이 신호보다 크다** —
      느려진 표본 하나를 보고 「인하 때문」이라고 적었으면 정반대 결론이 나갔을 것이다.
      판정하려면 표본마다 **동시 실행 잡과 호스트 부하를 함께 기록**해야 한다
      (`gh api …/runs/<id>/jobs` 의 `started_at`·`completed_at` 대조 + `uptime`).
    - ⚠️ **인하의 실제 이득은 VM 안이 아니라 호스트 쪽에 있다.** 위 🪤 가 보인 대로 CI
      시간을 좌우하는 것이 호스트 부하이므로, 논리 12스레드 중 VM 몫을 8 → 4 로 줄여
      호스트에 8개를 남기는 것은 **그 지배 변수 자체를 낮추는 방향**이다(타 세션의 로컬
      빌드·테스트가 도는 자리다). VM 안 처리량을 사려고 한 조정이 아니다.
      ⚠️ **「그러니 더 내려도 된다」로 확장하지 말 것** — 측정한 것은 4 하나다. 잡당 vCPU
      2.0 인 이 형상은 아래에서 기각된 3러너 형상(잡당 2.67)보다 **이미 더 얇고**, 여기서
      버티는 이유는 러너를 2개로 묶어 **겹침 수를 2로 고정**했기 때문이지 CPU 가 남아서가
      아니다.
      ⚠️ `VITEST_MAX_WORKERS` 는 **3 그대로 두었다** — 한 번에 한 가지만 바꿔야 차이를
      귀속시킬 수 있고, 상한 3 은 `nproc`(=4)보다 여전히 작아 구실을 한다.
  - **VM 안 활성 러너는 2개다(등록은 3개 — `imac-colima-3` 은 systemd 정지·disable
    상태의 예비). 동시 실행 자리는 러너 인스턴스 수가 정한다 (2026-08-26).** 워크플로의
    두 잡은 `needs` 의존이 없어 **원래 병렬 설계**인데, 러너 1개는 동시에 잡 1개만
    받으므로 자가호스트 전환 직후 그 병렬성이 통째로 사라졌다(실측: 대기 3건, 최장
    ~50분). 🪤 **이 증상을 워크플로 설정이 풀린 것으로 오진하지 말 것** — YAML 은
    그대로였고 바뀐 것은 처리 용량이다. 러너 수를 바꿔도 워크플로 파일은 손대지
    않는다(라벨 `self-hosted` 공유).
  - ⛔ **3개를 동시에 켜지 말 것 — 당일 실측으로 기각된 형상이다.** ⚠️ **아래 수치는 VM 이
    8 vCPU 이던 시점의 것이다**(2026-08-27 부터 4 — 위 T-070 항목). 형상이 더 얇아졌으므로
    이 기각은 약해지지 않고 **더 강하게** 성립한다. 8 vCPU 에 잡 3개가
    겹치면 vitest 워커 상한을 걸어도 빌드·`npm ci` 가 상한 밖에서 코어를 다퉈 5초
    벽시계 단언이 무더기로 터진다(교차 표본 5개: test 잡 27~29분에 타임아웃 12~76건,
    30초 타임아웃까지 4건, **런마다 실패 파일이 회전** — 결정론적 결함이면 같은 곳에서
    멈춘다). preflight(빌드)도 5분35초 → 22분으로 늘었다. 즉 병목은 잡 내부 동시성이
    아니라 **여러 PR 잡의 겹침**이고, 겹침 수 자체를 2로 줄이는 것이 처방이다.
    큐가 상시 밀리면 러너 3개 · 메모리 상한 12GB+ · `cpu` 8 이상 — **셋을 한 묶음으로**
    올리는 것이 다음 수순이다. ⚠️ 종전 서술은 「러너 3개 + 메모리」 둘만 짝지었는데,
    2026-08-27 인하로 `cpu` 가 셋째 축이 됐다 — 하나만 올리면 나머지가 그대로 병목으로
    남는다(`imac-colima-3` 재기동은 `sudo systemctl enable --now <서비스>` 한 줄).
  - **넘쳤을 때의 자가복구 두 겹(2026-08-27 OOM 이후 도입) — 상한을 올리는 대신 이걸
    택했다.** 상한은 피크 작업량이 아니라 내줘도 되는 양으로 정한다는 오너 결정(위)이
    그대로라, 처방은 8GB 를 지키면서 **넘친 순간을 흡수하고 스스로 일어나게** 하는 쪽이다.
    - ①**스왑 2GB + `vm.swappiness=10`**(`/swapfile` · `/etc/fstab` 에 `sw,nofail` ·
      `/etc/sysctl.d/99-swappiness.conf`). ⛔ **스왑을 더 키우지 말 것 — 막는 것은
      메모리가 아니라 디스크다**(적용 후 `/` 여유 6.3G, 러너 작업공간이 한 대당 ≈1.9G).
      ⛔ **`swappiness` 를 기본값(60)으로 되돌리지 말 것**: 평상시에도 스왑을 타면 빌드가
      상시 느려져 **위 「3개 동시」가 기각된 이유였던 5초 벽시계 단언 무더기 실패가 다른
      얼굴로 돌아온다.** 10 은 "진짜 압박일 때만 쓴다"는 뜻이다.
    - ②**러너 유닛 `Restart=always` · `RestartSec=15`**(두 러너의 systemd 드롭인
      `…service.d/restart.conf`). 근거는 GitHub `svc.sh` 기본값이 **`Restart=no`** 라는
      것이다 — OOM 으로 죽으면 저널에 `Runner listener exit with 0 return code, stop the
      service, no retry needed.` 만 남고 **사람이 손으로 켤 때까지 큐가 정체한다**(실제로
      그렇게 됐고 오너가 수동으로 켰다). ⛔ 이 드롭인을 지우면 그 상태가 돌아온다.
    - ⚠️ **이건 「이제 안 넘친다」가 아니라 「넘쳐도 스스로 일어난다」이다.** 잡 1건이
      취소돼 재실행이 필요한 일은 여전히 가끔 생긴다 — CI 실패를 보면 이 가능성을 먼저
      의심하고, 실패한 테스트가 로컬에서 재현되지 않으면 재실행으로 가른다.
  - 🪤 **colima 는 기본값으로 호스트 docker 컨텍스트를 가로챈다**(`autoActivate`) —
    프로덕션 Supabase 스택을 조작하는 스크립트가 전부 현재 컨텍스트를 쓰므로, 켜진
    채 재부팅하면 그 스크립트들이 **빈 VM 을 조작한다**(조용한 오작동). 그래서
    `~/.colima/default/colima.yaml` 의 `autoActivate: false` 가 필수이고, 호스트 기본
    컨텍스트는 `desktop-linux` 를 유지한다(러너는 VM 안에서 자기 docker 를 쓴다).
  - **폴백 = 레포 변수 토글 — 이 장치가 「러너 사망 = 전 PR 머지 불가」를 닫는다.**
    두 잡의 `runs-on` 은 `${{ vars.PREFLIGHT_RUNNER != '' && vars.PREFLIGHT_RUNNER ||
    'ubuntu-latest' }}` 다. 변수를 지우면 **PR 없이 즉시** GitHub 러너로 복귀한다:
    ```bash
    # 폴백(맥 러너 장애 시): 다음 run 부터 ubuntu-latest
    gh api -X DELETE repos/indexzigu/wagcrm_git/actions/variables/PREFLIGHT_RUNNER
    # 복귀(러너 복구 후):
    gh api -X POST repos/indexzigu/wagcrm_git/actions/variables -f name=PREFLIGHT_RUNNER -f value=self-hosted
    ```
    변수는 run 시작 시점에 읽히므로 이미 큐에 걸린 run 은 재실행해야 새 값을 탄다.
    실행 주체는 기존 「Merge & Promote」와 같은 결이다 — 오너, 또는 오너 지시를 받은
    세션. 장애를 발견한 세션은 임의로 지우지 말고 장애 증거(러너 offline·큐 정체)와
    함께 이 명령을 보고로 넘긴다.
    ⚠️ pull_request run 은 그 PR 머지 커밋의 워크플로 파일을 쓰므로, 토글 착지 전에
    갈라진 구 브랜치 PR 은 변수와 무관하게 `ubuntu-latest` 로 돈다 — 결함이 아니다.
  - ⛔ **러너에 프로덕션 시크릿을 두지 않는다.** 등록에 쓴 것은 1시간짜리 일회용 등록
    토큰뿐이다. 잡이 받는 `secrets.*` 는 GitHub 이 run 시점에 주입하는 기존 경로
    그대로다(러너 이전과 무관). ⛔ 러너·VM 에서 레포 `.env` 로 빌드·테스트를 돌리지
    말 것 — `DATABASE_URL` 이 프로덕션이다(P0). CI 는 워크플로가 주는 환경만 쓴다.
  - ⚠️ **자가호스트 러너는 잡을 그 기계(VM) 그대로 실행한다.** 비공개 단일 오너
    레포라 외부 PR 위험은 없지만, 워크플로를 수정하는 PR 은 이 러너에서 임의 코드를
    돌릴 수 있다 — 레포 쓰기 권한 = 러너 실행 권한이다.
  - 🪤 **`actions/*` 캐시는 자가호스트에서 순손해다 — `cache: npm` 을 러너 토글과 같은
    변수로 껐다.** 그 캐시는 GitHub **캐시 서비스에서 내려받는** 것이라 데이터센터 밖
    러너에서는 이득이 아니라 비용이다(실측 2026-08-26: 416MB 를 0.4~0.9MB/s 로 받아
    `Setup Node.js` 한 스텝이 **12분**, `test` 잡이 20분 타임아웃으로 취소됐다).
    자가호스트 러너는 홈의 `~/.npm`(실측 480MB)이 잡 사이에 그대로 남으므로 원격 캐시가
    애초에 필요 없다. ⛔ 이 조건부를 "일관성" 이유로 `cache: npm` 으로 되돌리지 말 것 —
    GitHub 러너로 폴백했을 때는 작업 공간이 매번 새것이라 캐시가 다시 이득이므로, 두
    레인의 정답이 서로 다르다. 같은 논리가 다른 `actions/cache` 계열에도 적용된다.
  - 🪤 **맨 VM 에는 GitHub 러너 이미지의 기본 탑재물이 없다.** 최초 구축에서 실측한
    누락 2건: `build-essential`(없으면 `better-sqlite3` 가 프리빌드 없는 node 버전에서
    node-gyp 소스 빌드로 폴백하다 죽어 `npm ci` 전체 실패) · `sqlite3` CLI(없으면 vitest
    global-setup 의 `VACUUM` 이 `spawnSync ENOENT`). 증상이 전부 **제품 코드 실패처럼
    보이므로**, 자가호스트에서만 깨지는 실패는 GitHub 러너 폴백으로 한 번 대조해
    "코드인가 러너인가"를 먼저 가른다.
  - 🪤 **메모리 상한은 "드물게 닿는 천장"이 아니라 "호스트에서 영구히 떼어 주는 양"이다
    (2026-08-26 실측으로 판정 — 종전 「미검증 후속 과제」를 대체한다).** VM 은 상한까지
    올라가 **거기서 머문다.** 게스트가 그 뒤 메모리를 비워도 호스트로는 한 바이트도
    돌아오지 않는다. 그래서 상한은 피크 작업량이 아니라 **내줘도 되는 양**으로 정한다.
    - **실측(러너 3개·상한 16GB 구성):** 잡 부하 중 호스트 점유가 13GB → **16GB**
      로 올라 상한에 붙었고(`phys_footprint_peak` = 현재값), 게스트 안에서
      `drop_caches` 로 페이지 캐시 8,316MB → 905MB(**7.4GB 해제**)를 만든 뒤에도
      호스트 점유는 **16GB 그대로**였다. 3분 뒤 게스트 사용량이 2,775MB 까지
      내려가(12GB 가 게스트 안에서 놀고 있는 상태) 호스트는 여전히 16GB 였다.
    - ⛔ **주기적 `drop_caches` 반환 장치를 만들지 말 것 — 효과가 0 임이 확인됐다.**
      원인은 튜닝이 아니라 **통로 부재**다: 게스트의 virtio-balloon 이
      `VIRTIO_BALLOON_F_REPORTING`(기능 비트 5)을 협상하지 못해
      `/sys/kernel/mm/page_reporting/` 이 생기지 않는다(커널은 `CONFIG_PAGE_REPORTING=y`
      로 빌드돼 있다 — **게스트는 할 줄 아는데 호스트가 그 기능을 켜 주지 않는다**).
      해제된 페이지를 호스트에 돌려줄 경로가 없으므로 게스트에서 무엇을 비우든 결과가
      같다. 회수하는 방법은 **VM 재기동뿐**이고, 그건 러너를 죽이므로 함부로 하지 않는다
      (아래 폴백 토글 항목과 같은 결 — 잡 실행 중 재기동은 required 체크를 깬다).
    - 🪤 **`limactl` 프로세스의 RSS 로 재지 말 것 — 게스트 메모리가 거기 안 잡힌다.**
      PR #481 에 근거로 적힌 "유휴 시 호스트 상주 122~176MiB"는 이 착오의 산물이다
      (같은 시점 실제 점유는 GB 단위였다). macOS Virtualization.framework 는 VM 메모리를
      **별도 XPC 헬퍼 프로세스**에 잡아두므로 판정은 그쪽 `phys_footprint` 로 한다.
      이 지표는 잡 부하와 무관하게 늘 100MiB 안팎을 돌려주므로 **"거의 점유 안 한다"는
      틀린 결론과 얼굴이 같다** — 반증할 계기가 안 생기는 형태의 오측정이다.

      ```bash
      # 프로세스가 2개 나온다 — 기동 경과가 짧은 쪽이 colima, 오래된 쪽이 Docker Desktop
      for p in $(pgrep -f com.apple.Virtualization.VirtualMachine); do
        echo "pid=$p 경과=$(ps -o etime= -p $p)"; footprint -p $p | grep phys_footprint:
      done
      ```
    - ⚠️ **호스트 총량과 함께 볼 것.** 이 맥은 32GiB 이고 프로덕션 Docker Desktop VM 이
      별도로 ~2.6GB 를 상주로 쓴다. CI VM 상한을 올리면 그만큼이 **영구히** 빠지므로,
      상한 변경은 러너 병렬도만의 문제가 아니라 이 기계 전체의 여유 메모리 문제다
      (16GB 상한 실측 시점의 호스트: unused 196MB · compressor 2,991MB).

- **Migration Guard — 전 PR 에서 도는 게이트:** `Migration Guard / guard`는 모든 PR에서
  돈다. ⛔ 종전 「required 상태다(`main-protection` ruleset)」는 **SUPERSEDED**(T-069
  보호 정지 — 위 「Main Push Guard & Deploy CI Gate」) — 지금 서버는 guard 실패 머지를
  막지 않지만, **배포 직전 게이트(deploy.sh ⑦)가 모든 배포 커밋의 원 PR 에 guard
  success 를 요구**하므로 사실상의 required 다. 일회용 Postgres(shadow DB)에
  ① 전체 마이그레이션을 `migrate deploy`로 적용해 깨진 SQL을 잡고 ②
  `migrate diff --exit-code`로 `schema.prisma`↔`prisma/migrations` 동기화를
  검증한다(마이그레이션 생성 누락 → 배포 시 자동 적용 실패·P2022 방지). prod
  시크릿 불요·fork PR도 작동. `paths:` 필터를 두지 않으며(스킵된 PR 은 문② 게이트가
  배포 거부하고, 보호 부활 시엔 "스킵된 required" 데드락이 되살아난다 — 워크플로 주석
  참조), prisma 파일을 안 건드리는 PR은 검증을 스킵하고 guard가 자동 통과한다.

- **New Table ⇒ New RLS — 새 테이블은 RLS 를 함께 켠다 (2026-07-31):** `public` 스키마에
  테이블을 추가하는 마이그레이션은 **같은 PR 에** `ALTER TABLE "<T>" ENABLE ROW LEVEL
  SECURITY;` 를 넣는다(정책은 만들지 않는다 — 0개면 anon·authenticated 전면 거부이고,
  Prisma 가 쓰는 `postgres` 롤은 소유자라 우회하므로 **앱 동작 무변화**다. `FORCE` 는 쓰지
  않는다 — 소유자까지 RLS 대상이 되어 Prisma 경로가 깨진다).
  - **왜 규약이 필요한가 — 스냅샷 마이그레이션은 한 번만 맞다.**
    `20260715120000_enable_rls_public_tables` 는 07-15 시점 57개 테이블을 손으로 열거했고
    다시 돌지 않는다. 그 뒤 생긴 테이블은 아무도 켜주지 않아 **9개가 누락**돼 있었다
    (2026-07-31 실측, `20260731120000_enable_rls_new_public_tables` 로 정리). 결함은 그
    9개가 아니라 **재발 구조**였다.
  - **⚠️ `Migration Guard` 로는 구조적으로 못 잡는다** — RLS 는 Prisma datamodel 밖이라
    `migrate diff` 가 영원히 "무드리프트" 라고 답한다. 그래서 판정은 계약 테스트
    `src/lib/__tests__/rls-coverage.contract.test.ts` 가 한다(`schema.prisma` 모델 ↔ 전
    마이그레이션의 ENABLE 문 대조, 누락 시 required `test` 체크 실패). 이쪽은 `guard` 와
    달리 prisma 경로 필터가 없어 **모든 PR 에서** 돈다.
  - **바깥 겹(GRANT)은 레포 가드로 못 본다 → 크론이 본다 (2026-07-31):** 방어는 두 겹이다
    — ①`20260716130000_revoke_public_grants_from_anon` 의 GRANT 회수(anon 의
    `/rest/v1/<table>` 이 **401** 로 끊긴다) ②RLS(정책 0개라 행이 안 나간다). 그런데 ①은
    **DB 쪽에서 벗겨질 수 있고 레포에는 흔적이 남지 않는다** — 그 마이그레이션 자신이
    경고한 대로 "Supabase 가 플랫폼 업그레이드 시 자체 마이그레이션으로 기본권한을 재부여할
    수 있다(무증상 되돌림)". **무증상이 핵심이다**: 되돌아가도 앱은 멀쩡히 돈다(Prisma 는
    `postgres` 롤이라 그랜트·RLS 양쪽과 무관) → 사람이 알아차릴 계기가 없다.
    그래서 크론 `db-exposure-audit`(매일 02:00 KST)이 6항목을 카탈로그로 점검하고, 어긋나면
    `failed: true` 로 **시스템 레이더를 빨강으로** 만든다: public 스키마의 ⓐ관계 GRANT
    ⓑ함수 GRANT ⓒ`pg_default_acl` 재등장(가장 위험 — 지금 객체는 깨끗해도 **다음
    마이그레이션이 만드는 테이블부터** 다시 열린다) ⓓ**PUBLIC 의사롤** 부여 ⓔ**컬럼 단위
    GRANT** ⓕRLS 미적용.
    - 🪤 ⓓⓔ는 교차검증에서 드러난 사각이다. GRANT 점검을 `pg_roles` 조인으로 쓰면
      **PUBLIC 을 절대 못 본다** — `aclexplode` 가 PUBLIC 을 `grantee = 0`(실재하지 않는 롤
      OID)으로 주기 때문이다. `GRANT SELECT ON "Seller" TO PUBLIC` 한 줄이면 anon 도 읽는데
      감사는 조용하다. 컬럼 단위 부여도 `relacl` 이 아니라 `pg_attribute.attacl` 에 저장돼
      관계 GRANT 점검이 통째로 놓친다. ⓓ에서 **함수는 제외한다** — Postgres 가 함수 EXECUTE 를
      PUBLIC 에 기본 부여하므로 넣으면 상시 오탐이다(테이블은 기본이 소유자 전용이라 부여
      자체가 이상 신호다).
    - 로직 SSOT `src/lib/db-exposure-audit.ts` · 계약 `db-exposure-audit.contract.test.ts`.
    - sqlite·비 Supabase(shadow DB)는 **skip**이지 실패가 아니다 — 그 환경엔 이 불변식이
      없다. skip 을 실패로 승격하면 데모 프로젝트 레이더가 매일 빨강이 된다.
    - ⚠️ **테이블 0개는 "깨끗함"이 아니라 "감사 불능"으로 판정한다**(`broken`). 권한 부족·
      엉뚱한 DB 연결이면 위반도 0건으로 나오는데, 그걸 ok 로 읽으면 감사기가 죽은 채 매일
      초록을 찍는다(`capture-stories` 11일 무음 실패와 같은 실패 모드).
    - 🪤 **이 감사의 SQL 은 목킹 테스트로 검증되지 않는다.** 실제로 초판이
      `operator is not unique (42725)` 로 통째로 실패하는 동안 단위 테스트 49건은 전부
      green 이었다. SQL 을 고치면 **읽기 전용 레인에서 실 DB 로 한 번 돌리고**, storage
      스키마 양성 대조군으로 "늘 빈 배열을 주는 고장"과 구분한다.
  - **심각도 판단 — 누락 = 유출이 아니다.** `20260716130000_revoke_public_grants_from_anon`
    이 anon 롤의 public 스키마 기본 권한을 회수해 둬서, 위 9개도 `role_table_grants` 에
    anon 행이 0건이었다(실측). Supabase advisor 의 "anyone with the anon key can read or
    modify every row" 경고는 **기본 GRANT 생존을 전제**하므로 이 DB 에는 그대로 적용되지
    않는다. RLS 누락은 **심층방어 공백**으로 다루고 긴급 사고로 승격하지 않는다 — 단,
    GRANT 를 되돌리는 변경은 그 두 번째 겹이 있는지 먼저 확인하고 한다.

- **Demo Deployment (외부 시연용 목업 배포, 2026-07-21):** ⛔ **지금 배포된 데모는 없다**
  (2026-08-26 실측 — 아래가 말하는 별도 Vercel 프로젝트가 계정에서 사라졌다). 로컬 데모
  (`npm run dev:demo` · `npm run demo:seed` · `npm run build:demo`)와 `DEMO_MODE` 코드
  경로는 **그대로 살아 있다** — 없어진 것은 배포처뿐이다. ⚠️ **아래 규약은 완화된 것이
  아니라 되살릴 때 그대로 밟아야 하는 조건이다.** 비로그인 열람 데모는
  **별도 Vercel 프로젝트**(같은 레포)로만 운영한다 — 실 프로덕션에 `DEMO_MODE`를
  설정하지 않는다. 데모 프로젝트 설정: Build Command=`npm run build:demo`,
  env는 `DEMO_MODE=1`·`NEXT_PUBLIC_DEMO_MODE=1`·`DATABASE_URL=file:./demo.db`
  **셋뿐**이다(Supabase·네이버 등 시크릿 일절 등록 금지 — 미들웨어가 인증을
  우회하는 대신 `prisma-client`가 postgres 연결을 거부해 "인증 우회+실DB"
  조합이 성립하지 않는다). 데이터는 빌드 시점에 `prisma/seed-demo.ts`가 허구
  픽스처로 sqlite(`prisma/demo.db`)를 시드한다 — **날짜가 빌드 기준 상대값이라
  데모가 낡으면 Redeploy가 곧 갱신**이다. 쓰기(비-GET)·`/api/cron`·`/api/auth`는
  미들웨어가 403으로 차단한다(`middleware.test.ts` 데모 레인 계약). 데모
  픽스처에 실셀러·실브랜드·실측치를 넣지 않는다(P0 — 사유 정본은 AGENTS.md
  Public Repo Data Guard. 2026-08-26 비공개 전환 후에도 유지한다). 더구나 데모
  프로젝트는 **배포물 자체가 공개**라 레포 가시성과 무관하게 그대로 노출된다.
  vercel.json 에는 crons 가 없으므로(아래) 데모 프로젝트에 등록되는 크론도 없다.

- **Cron Source of Truth:** 크론 스케줄 정본은 **`infra/selfhost/crontab`**(오너 맥,
  KST로 돈다)이다. 2026-08-13 컷오버로 발화 주체가 그 기계로 옮겨졌고,
  **2026-08-15 에 `vercel.json` 의 `crons` 를 전부 제거했다.**
  **⛔ SUPERSEDED**: 종전 "정본은 `vercel.json`의 `crons`"(2026-07-20 Pro 전환으로
  GitHub Actions에서 복귀)는 무효다. 제거한 이유는 미화가 아니라 **실사고**다 —
  컷오버 뒤에도 구 Vercel 배포가 같은 잡을 계속 발화해 자체호스팅과 이중 실행되고
  있었다(07:00 자체호스팅 / 07:01 구 배포, 클라우드 DB 쓰기로 실측). `vercel.json` 은
  **배포마다 크론을 재등록**하므로 파일에 남겨 두는 것 자체가 부활 장치였다.
  - **롤백 시 함의가 뒤집혔다:** 이제 승격해도 구 플랫폼에 크론이 **하나도**
    등록되지 않는다(자동 부활 없음 = 안전 기본값). 롤백이 길어지면 그 제거를
    되돌리는 별도 PR 이 필요하고, 그 전에 자체호스팅 crontab 을 먼저 꺼야 한다.
    짧은 롤백은 Actions → "Scheduled Crons" 수동 실행으로 버틴다
    (안내 정본 `rollback.sh` Step 4).
  - 스케줄·잡 목록 변경 시 `infra/selfhost/crontab` 과 `KNOWN_JOBS`
    (`src/lib/cron-jobs.ts` — 레이더 표시와 수동 실행 허용 목록의 SSOT)를 함께
    갱신한다. 정합은 `cron-jobs.contract.test.ts` 가 강제한다 — C6=존재,
    C5=표기(cycle·timeKst) 일치, C2=로컬 레인 부재 + `vercel.json` 에 crons 부활 금지.
    ⚠️ 레포만 고치면 발화하지 않는다 — 그 기계에서 `crontab infra/selfhost/crontab`
    재설치가 필요하다(`deploy.sh` 는 crontab 을 재설치하지 않는다).
  - 일시중단 잡(collect-reviews)은 crontab·`KNOWN_JOBS` 양쪽에서 뺀다.
  - Vercel 크론 경로를 되살릴 때: Vercel은 `Authorization: Bearer <CRON_SECRET>`를
    자동 첨부하므로 각 라우트의 `verifyCronAuth`가 그대로 검증한다 — **Vercel
    production env에 `CRON_SECRET` 필수**(없으면 무증상 401).

- **Plan Limits — 플랜이 Hobby 로 돌아왔다 (2026-08-26 실측):** 계정
  `indexzigus-projects` 의 플랜은 `hobby`(무료)다. ⛔ **종전 절 제목·본문의 「Pro 전환 후
  (2026-07-20)」 전제는 SUPERSEDED.** 그때 "Hobby는 함수 실행을 60초로 클램프한다
  (`maxDuration` 선언값을 덮어씀)"를 무효로 돌리고 "Pro는 Fluid 함수 기본 300s·최대
  800s(nodejs20/22/24는 1800s beta)"로 갱신했었는데, **플랜이 되돌아왔으므로 그
  무효화가 다시 무효다.**
  - ⚠️ **60초 클램프를 살아 있는 것으로 보고 계획한다.** 당시 실측이 정확히 그것이었고
    (문서는 Hobby도 300s라는데 실측은 60s 클램프였다), 지금은 재측정할 수단이 없다 —
    Vercel 은 롤백 창구라 평소에 함수가 돌지 않는다. 확인은 **롤백을 실제로 올릴 때**
    장기 실행 라우트부터 한다. ⛔ 이 절을 근거로 "이제 300s 다"라고 예산을 넓히지 말 것.
  - 장기 실행 라우트의 **예산 앞쪽 배치(데드라인 분할·이월) 설계는 그대로 유지**하고
    예산 상수를 60s 위로 올리지 않는다. 종전 조건 "첫 Pro 회차에서 60s 초과 완주를
    실증한 뒤"는 **전제가 사라져 성립하지 않는다**(재점검 핸드오프
    `docs/handoff/vercel-pro-reaudit.md` 도 이 레포에 없다 — 모드 L 파일이라 유실됐다).
  - ℹ️ **평시 영향은 없다.** 프로덕션은 셀프호스트가 서빙하고 `vercel.json` 에는 crons 도
    없다(위 Cron Source of Truth) — 이 절이 되살아나는 것은 롤백 창구를 실제로 올릴 때뿐이다.
  - 크론 실행 여부 판정은 로그가 아니라 `SystemTaskStatus`·DB 부수효과·시스템 레이더로
    한다 — 이 규칙은 **플랜과 무관하게 유지**한다(로그 보존 기간이 Pro 1일이든 Hobby 든
    주간 크론 판정엔 부족하다는 것이 원래 근거다).

- **셀러 자동수집은 "요일"이 아니라 "갱신 경과일"로 돈다 (2026-07-30):**
  `collect-instagram`·`collect-youtube`는 **매일** 발화하고, 실제 수집 여부는
  셀러별 cutoff(`src/lib/collect-cycle.ts`, 기본 7일 · `FOLLOWERS_SYNC_INTERVAL_DAYS`)가
  정한다. 종전의 "매주 월 1회 발화"는 이미 있던 7일 게이트와 맞물려 **실효 주기를
  14일로 늘렸다** — 월요일 시점에 6일밖에 안 지난 셀러(수동 분석 등으로 중간에
  갱신된 경우)는 게이트에 걸려 스킵되고 다음 기회가 7일 뒤였다. 실패분과
  `ENGAGEMENT_BUDGET_MS` 데드라인 이월분도 마찬가지로 일주일씩 밀렸다(오너 체감:
  "자동수집이 될 때도 있고 안 될 때도 있다"). **⛔ 크론을 주 1회로 되돌리지 말 것** —
  `cron-jobs.contract.test.ts` C5가 이 불변식과 레이더 표기 정합을 함께 고정한다.
  - **매일 전환의 비용은 0이다(전환 시점 실측):** 스크랩되는 셀러 **총량은 그대로**이고
    발화 횟수만 늘어난다 — 각 회차는 7일 경과분만 고르기 때문이다. Instagram은 Tier0 BD
    무료 경로다.
  - ⚠️ **YouTube + `YOUTUBE_COLLECT_MODE=apify` 조합만 예외 가능성이 있다.**
    `youtube-collector`의 Apify 분기는 대상 셀러 전원을 `startUrls` 한 배열에 담아
    **크론 1회 = 액터 run 1회**로 묶는다. 매일 발화는 run 횟수를 7배로 늘리므로,
    액터 과금이 **컴퓨트 유닛(메모리×시간)** 기준이면 run당 부팅 오버헤드를 7번 내게 된다
    (**건당 과금이면 차이 없음**). 전환 시점에는 감시 YouTube 셀러가 0명이고 90일간 호출
    기록도 0건이라 실익이 없어 그대로 매일로 뒀다 — 감시 YouTube 셀러를 실제로 넣고
    apify 모드를 쓰게 되면 그때 액터 과금 모델을 Apify 콘솔에서 확인하고 재검토할 것.

- **암호화 키 교체 런북 — 순서를 틀리면 프로덕션이 조용히 깨진다 (2026-07-23):**
  무중단 교체의 일반 패턴(신키+`*_PREVIOUS` 선등록 → 현재→구 키 순 복호화 배포 →
  멱등 재암호화 → PREVIOUS 제거, 복호화 실패는 throw)의 정본은 전역
  `~/.gemini/config/rules/security.md` §Zero-Downtime Key Rotation 이다
  (2026-08-01 승격). 아래는 이 레포의 구체 런북이다.
  `ENCRYPTION_KEY`(셀러 주민등록번호)는 폴백 기본 키가 없다. 예전에는 소스에 박힌
  기본 키로 폴백했고 레포가 공개돼 있어 그 키가 곧 공개된 키였다.
  - ⚠️ **키만 바꾸고 기존 행을 두면 안 된다.** 저장 형식이 `iv:tag:ciphertext`라
    복호화가 실패하는데, **구 구현은 실패 시 원문(=암호문)을 그대로 반환**해서
    주민번호 자리에 암호문이 뜨고도 에러가 나지 않았다(이제는 던진다).
  - **순서(무중단):**
    1. Vercel에 새 키를 `ENCRYPTION_KEY`, **구 키를 `ENCRYPTION_KEY_PREVIOUS`** 로 등록
       — 이 단계가 배포보다 **먼저**다. 안 하면 배포 즉시 셀러 상세·정산이 던진다.
    2. 코드 배포(복호화가 현재 키 → 구 키 순으로 시도한다)
    3. `npx tsx scripts/reencrypt-resident-numbers.ts` (예행) → **`복호화 실패`가 0**인지 확인
    4. `... --apply` (변경 전 값은 `/tmp`에 권한 600으로 백업된다 — 확인 후 삭제)
    5. `ENCRYPTION_KEY_PREVIOUS` 제거
  - 스크립트는 **멱등**하다(이미 새 키로 열리는 행은 건너뛴다) — 중단 후 재실행 안전.
  - `check-env`가 `ENCRYPTION_KEY` 누락을 오류로, `ENCRYPTION_KEY_PREVIOUS` 잔존을
    경고로 잡는다. `release-config-shared`의 required/optional 목록도 같이 본다.
  - **⚠️ 그 두 장치는 "키가 데이터와 어긋났다"를 못 본다 → 크론 `encryption-key-audit`
    (매일 02:30 KST)이 본다 (2026-08-13 실사고):** 셀프호스팅 컷오버 때 `ENCRYPTION_KEY`
    가 컷오버 전 값과 달라져 셀러 몇 명의 주민등록번호가 현재 키로 열리지 않는 상태가
    됐는데 **며칠간 아무도 몰랐다.** 대량 조회 경로의 `decryptOrNull()` 이 실패를
    `console.warn` 으로 남기고 빈칸을 돌려주기 때문이다(그 설계는 유지한다 — 한 행이
    프리렌더를 죽이면 피해가 원인보다 크다). 화면에서는 **미입력과 구분되지 않았고**,
    빌드 프리렌더 로그를 우연히 읽다가 발견됐다. `db-exposure-audit` 과 같은 부류의
    무증상 열화다.
    - **실행 위치가 요점이다.** 검사 대상은 "앱이 지금 쓰는 키 × 앱이 지금 붙은 DB" 쌍
      이므로 CI(preflight 는 일회용 Postgres — 데이터 0건)로는 **원리적으로 볼 수 없다.**
      ⛔ 종전 근거 「개발 머신 스크립트(레포 `.env` = 구 Supabase)로도 못 본다」는
      **SUPERSEDED**(2026-08-13 셀프호스트 컷오버 · 2026-08-26 실측) — 지금 레포 `.env` 는
      셀프호스트 프로덕션 DB 를 가리키고 `ENCRYPTION_KEY` 도 프로덕션과 지문(sha256 앞
      10자 + 길이)이 같아 **개발 머신에서도 같은 쌍이 보인다.** 그래도 크론인 이유는 바뀌지
      않았다: 무증상 열화는 **누가 우연히 돌려보는가**에 기댈 수 없고 매일 자동으로 세야 한다.
    - 판정 SSOT `src/lib/encryption-audit.ts`, 등급 판독기는
      `classifyDecryptability`(`src/lib/encryption.ts` — 값을 돌려주지 않는다),
      계약 `encryption-audit.contract.test.ts`. 읽기 전용·부수효과 0, 보고는 **개수와
      셀러 id 만**(값·키 금지, P0).
    - **이 런북 3~4단계를 도는 동안은 레이더가 빨강인 것이 정상이다** — 구 키로만 열리는
      행(`previousKeyOnly`)도 빨강으로 센다. `ENCRYPTION_KEY_PREVIOUS` 를 제거하는 순간
      그 행들이 이번 사고와 똑같이 빈칸이 되므로, 5단계까지 끝내면 초록으로 돌아온다.
    - 평문 행(암호화된 적 없는 값)은 개수만 보고하고 빨강으로 올리지 않는다 — 축이 다른
      문제(저장 위생)이고, 섞으면 두 신호가 함께 흐려진다.
  - 같은 계열: `ASSET_TOKEN_ENCRYPTION_KEY`(구글 드라이브·캘린더 refresh 토큰)도
    폴백을 제거했다. 이쪽은 prod·로컬 모두 이미 설정돼 있어 재암호화가 불필요했다.

- **CI 결과 오독 금지 — `cancelled`·`X` 는 실패가 아닐 수 있다 (실사고 2건):**
  판독 원칙 정본은 전역 `~/.gemini/config/AGENTS.md` §「CI·배포 결과 판독」이다
  (concurrency 취소는 설계 — 취소된 run 의 커밋은 **다음 run** 이 같은 트리로
  검증하므로 검증 공백이 아니다 · 타임아웃 정각 취소 + 실패 어노테이션 0 =
  코드 실패가 아니라 CI hang, 진짜 실패면 어노테이션이 붙는다 — 2026-08-01 승격).
  이 레포의 좌표:
  - `preflight` 의 concurrency group 이 `${{ github.ref }}` 라 main 에서 항상 같은
    값 — 후속 머지가 이전 run 을 취소한다(최신 run 만 살아남는 설계).
  - `test` 의 hang 서명은 **그 잡의 `timeout-minutes` 정각** `CANCELLED` —
    `gh run rerun --failed` 로 통과한다. ⛔ **분 수를 이 줄에 적지 말 것.**
    종전 서술 「**25분 정각**」은 낡은 것이 아니라 **처음부터 틀렸다** — 이 줄이 들어온
    2026-07-31(#191) 시점에 실제 값은 이미 **20** 이었고(레포 출범 `b6aead57` 이래 줄곧
    20, 25 였던 적이 없다), **대조하는 장치가 없어** 26일간 아무도 몰랐다. #495 에서 값이
    또 바뀌었으니 숫자를 다시 박으면 같은 자리에서 또 낡는다. 정본은 워크플로 파일이다:
    ```bash
    awk '/^  test:/{f=1} f&&/timeout-minutes:/{print $2; exit}' .github/workflows/release-preflight.yml
    ```
    바뀐 사유(폴백 레인의 여유가 1분이라 탈출구 구실을 못 했다)도 그 파일의 주석에 있다 —
    여기 복제하지 않는다. 같은 이유로 이 파일은 크론 **개수**도 고정 숫자로 적지 않는다
    (위 「프리뷰에 앱 크론을 설치하지 않는다」 항목의 ⚠️).
  - 함께 볼 것: 배포 판정은 `state:success` 만 보지 말고 **description** 까지 읽는다
    (`Deployment has completed` vs `Canceled by Ignored Build Step` — 위 Two Projects 항목).
  - ⚠️ **반대 방향도 있다 — `pending` 이 미완이 아닐 수 있다(실사고 2026-08-11,
    PR #357).** required 체크(`preflight`/`test`)가 오래 `pending` 인데, 그 run 을 job
    단위로 열면 **run 은 `completed/success`, job 하나만 `in_progress` 로 굳어 있고**,
    그 job 의 **스텝은 테스트 실행 스텝과 `Complete job` 까지 전부 `completed/success`**
    였다 — 일은 끝났고 레코드 마감만 안 된 것이다. 같은 PR 에서 두 번 겹쳤고(1차엔
    `test`, 2차엔 `preflight`), 굳는 job 이 시도마다 바뀌고 같은 시간대 다른 브랜치
    run 은 정상 완료했다 — 코드 결함이면 같은 곳에서 멈춘다는 서명과 반대라 외부
    요인이다. 판독:
    ```
    gh api repos/indexzigu/wagcrm_git/actions/runs/<runId>/jobs \
      --jq '.jobs[] | "\(.name)\t\(.status)\t\(.conclusion)"'
    gh api repos/indexzigu/wagcrm_git/actions/runs/<runId>/jobs \
      --jq '.jobs[] | select(.name=="<job>") | .steps[] | "\(.number) \(.name)\t\(.status)"'
    ```
    **해제는 `gh run rerun` 이 아니라 빈 커밋으로 새 `synchronize` 이벤트를 내는 것**이다
    — `rerun` 은 같은 run 을 다시 굳히기만 했고(굳는 job 만 바뀜), 새 커밋이 체크
    레코드를 새로 만들어 풀렸다. 체크 배지만 보고 "테스트가 오래 돈다"로 읽으면
    원인을 코드에서 찾게 된다 — 오래 `pending` 이면 스텝 목록부터 연다.

- **Vercel CLI — 전역 설치본 금지·`env add` 가짜 성공 (실사고 2026-07-23):** 정본은
  전역 `~/.gemini/config/AGENTS.md` §「CI·배포 결과 판독」의 Vercel CLI 함정
  2종이다(2026-08-01 승격) — ①전역 `vercel`(54.0.0)은 `env add`/`env rm` 에서
  `--project` 미지원 → `npx --no-install vercel`(56.5.0+)로 실행. ②`vercel env add`
  는 stdin EOF 면 **아무것도 만들지 않고 exit 0**(가짜 성공) → `--non-interactive`
  를 붙이고 등록 후 `vercel env ls` 로 실재를 재조회한다.
