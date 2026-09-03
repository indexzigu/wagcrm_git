#!/usr/bin/env node
/**
 * board-drift-check — PROJECT_MASTER.md 의 상태 마커를 gh·git 객관 SSOT 와 대조한다.
 *
 * 왜 있나(실사고): 보드는 사람이 손으로 쓰는 주장 레지스트리라 "머지·배포됐는데 보드는
 * 아직 대기"로 벌어진다. 2026-07-21 에 마커 7건을 정정하는 전수 패스를 돌렸는데
 * **8일 만에 재발**해 2026-07-29 에는 보드가 참조하는 PR 42건이 **전부 MERGED** 인데도
 * "🔴 PR 오너 머지 대기" 마커가 16건 남아 있었다. 낡은 마커는 단순 미관 문제가 아니라
 * **완료된 작업에 재착수 지시가 나가는** 사고를 만든다(07-21 정리 패스의 촉발 사건이
 * 정확히 그것이었다).
 *
 * 설계 원칙:
 *  1. **읽기 전용이다. 보드를 자동 수정하지 않는다.** 보드는 여러 세션이 동시에 쓰는
 *     git 미추적 파일이라 되돌릴 이력이 없다 — 기계가 남의 줄을 고치면 동시 쓰기를
 *     통째로 덮어쓴다. 이 도구는 "어디가 어긋났나"만 말하고 판단·수정은 사람/세션 몫이다.
 *  2. **모르는 것을 미배포라고 하지 않는다.** 2026-07-21 main force-push(PII 스크럽)로
 *     그 이전 머지커밋 SHA 는 고아가 됐다 — git 이 모르는 SHA 를 "prod 에 없음" 으로
 *     보고하면 멀쩡한 기능에 재착수가 걸린다. 이 경우는 UNKNOWN_SHA 로 분리한다.
 *     같은 원칙이 **배포 축 자체를 모르는 경우**에도 걸린다(아래 DEPLOY_UNVERIFIABLE).
 *  3. **과대보고를 낡은 마커보다 더 위험하게 다룬다.** "배포 완료"라고 적혀 있는데 실제로
 *     프로덕션에 없는 것(P0 환각 보고)은 대기 마커가 낡은 것보다 해롭다.
 *  4. 머지됐지만 아직 프로덕션 호스트에 안 올라간 것은 **정상**이다(머지 ≠ 배포, P6).
 *     드리프트로 세지 않는다.
 *
 * 사용법:
 *   node scripts/board-drift-check.mjs            # 보드 자동 탐색 후 점검
 *   node scripts/board-drift-check.mjs --board <경로>
 *   node scripts/board-drift-check.mjs --json     # 기계 판독용
 *
 * 종료코드: 0=드리프트 없음(또는 점검 대상 없음) · 3=드리프트 있음 · 1=실행 오류
 *
 * ⚠️ **배포 판정 불가(마커 부재)는 종료코드에 반영하지 않는다 — 0 이다.** 마커는 프로덕션
 * 호스트에만 있으므로 클라우드 세션·fresh clone·CI 에서는 없는 것이 **정상**이고, 그걸
 * 실패로 올리면 이 점검기가 그 환경에서 상시 빨강이 되어 무시당한다(설계 원칙 3). 대신
 * 보고서 맨 앞에 판정 불가를 **명시**해, 배포 축이 꺼진 채 나온 "드리프트 없음"을 완전한
 * 초록으로 오독하지 않게 한다(그 상태에서는 과대보고 탐지도 함께 꺼져 있다).
 *
 * ⚠️ **판정기는 실행되는 워킹트리의 이 파일이다 — 낡은 브랜치에서 돌리면 낡게 판정한다.**
 * 보드(`PROJECT_MASTER.md`)는 메인 레포 루트의 단일 사본을 보지만(`resolveBoardPath`),
 * 스크립트는 그렇지 않다. 실측(2026-07-31): 메인 레포 워킹트리가 머지 완료된 피처
 * 브랜치에 머물러 있어 `npm run board:check` 가 옛 판정기를 실행했고, 이미 고친
 * 오탐 2건이 계속 보고됐다 — **도구가 고장난 것도 항목이 고아인 것도 아니었다.**
 * 결과가 이상하면 `git log --oneline -1` 로 그 체크아웃이 최신인지 먼저 확인할 것.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const REPO_SLUG = "indexzigu/wagcrm_git";

/**
 * **읽기 전용 아카이브 — 이관 이전 레포들.** 이관이 **두 번**이라 PR 번호가 세 겹이다
 * (`wag-crm` → `wagcrm` → `wagcrm_git`, 매번 이력 없이 #1 부터 재시작).
 *
 * 🪤 **번호만 읽으면 이 세 겹을 가를 수 없고, 그 결과가 상시 빨강이었다(실측 2026-08-29).**
 * 보드가 참조하는 26건이 전부 구 레포 번호인데 현행 레포에서 조회하니 전부
 * `PR_NOT_FOUND`(드리프트) 였다 — **진짜 드리프트는 0건인데** 점검기는 매번 26건을
 * 외쳤다. 상시 빨강은 곧 안 보게 되고 **그 학습이 진짜 드리프트까지 삼킨다**(이 도구가
 * 막으려던 2026-07-29 사고가 정확히 그것이다 — 설계 원칙 3의 연장).
 *
 * 두 레포 다 비공개로 살아 있어 오너 권한 `gh` 로 조회된다. 다만 이관이 이력을
 * 재작성했으므로 **머지 여부까지만** 알 수 있고 SHA 대조는 원천 불가다(P6 Repo Migration).
 */
export const LEGACY_REPO_SLUGS = ["indexzigu/wagcrm", "indexzigu/wag-crm"];

export const MAIN_REF = "origin/main";

/**
 * **프로덕션 배포 판정의 정본 = 셀프호스트 배포 마커다** (2026-08-15 레인 교체).
 *
 * ⛔ 종전 기준 `origin/release` 조상 여부는 **SUPERSEDED**. 2026-08-13 자체호스팅
 * 컷오버로 `deploy.sh` 가 `main` 을 추종하게 됐고 `release` 는 **구 플랫폼 롤백 창구**로만
 * 남았다(P6 Promotion Policy — 승격은 수동 전용). 그래서 `release` 는 롤백할 때 외에는
 * 전진하지 않는데, 판정기만 그 레인에 남아 **컷오버 이후 머지되는 모든 항목이 영구히
 * "승격 대기"로 쌓였다**(실측 2026-08-15: `origin/release` 가 08-13 에 멈춘 채 3건 오탐,
 * 그 3건은 전부 이미 프로덕션에 반영돼 있었다). 매일 늘어나는 위양성은 사람이 점검기를
 * 무시하게 만들고, 그게 이 스크립트가 애초에 막으려던 실패 양식이다(설계 원칙 3).
 *
 * 마커는 `deploy.sh` 가 **헬스체크까지 전부 성공한 뒤에만** 기록하므로(`infra/selfhost/
 * deploy.sh` — 빌드 실패 시 갱신되지 않는다) "지금 서빙되는 커밋"의 SSOT 다. 경로 규약도
 * 그 파일이 소유한다(프로덕션 `deployed.sha` / 그 외 레인 `deployed.<라벨끝>.sha`) —
 * 여기서는 프로덕션 레인만 본다. 같은 경로를 메뉴바 판정기
 * `infra/selfhost/release-status.sh` 도 읽는다.
 *
 * ⚠️ **이 기계가 프로덕션 호스트일 때만 존재한다.** 클라우드 세션·fresh clone 에는 없고,
 * 그건 고장이 아니라 정상이다 — 그 경우 배포 축은 **판정 불가**이지 미배포가 아니다
 * (설계 원칙 2). 테스트·프로브용으로 `BOARD_CHECK_DEPLOY_MARKER` 로 경로를 갈아끼울 수
 * 있다(실 마커를 건드리지 않고 음성 프로브를 돌리기 위한 통로 — 실 마커를 덮어쓰면
 * `deploy.sh` 가 "변경 없음"으로 조용히 종료하거나 불필요한 전량 재빌드를 한다).
 */
export function deployMarkerPath() {
  return (
    process.env.BOARD_CHECK_DEPLOY_MARKER || path.join(homedir(), "selfhost", "logs", "deployed.sha")
  );
}

/**
 * 마커 파일 내용 → 커밋 SHA. **형태가 아니면 `null`(판정 불가)이지 미배포가 아니다.**
 * 빈 파일·쓰다 만 파일·다른 내용이 "배포된 것이 없다"로 읽히면 보드 전체가 미배포로
 * 뒤집혀 대량 오탐이 난다 — 모르는 것은 모른다고 한다(설계 원칙 2).
 */
export function parseDeployMarker(raw) {
  if (typeof raw !== "string") return null;
  const sha = raw.trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

// ── 순수 로직(테스트가 고정하는 계약) ────────────────────────────────────────

/**
 * **항목 줄 판정은 구역마다 다르다** — 형태로는 갈리지 않기 때문이다(실측 2026-09-04).
 *
 * 종전 기준은 `- **` 하나였는데, 보드에 새로 올라오는 항목이 하네스 세션명 규약
 * (`상태프리픽스 #PR번호 [계보슬러그] 제목`)을 그대로 쓰면서 **볼드 없이 이모지로
 * 시작**하게 됐다(`- ✅ #7 #8 #9 [슬러그] …`). 옛 산문형(`- 착수 대기: …`)도 같이
 * 빠져 있었다. 그렇게 빠진 줄은 대조에서 통째로 제외돼 **낡아도 점검기가 조용하다** —
 * 상시 빨강(설계 원칙 3)보다 나쁘다. 빨강은 눈에라도 띄지만 침묵은 안 띈다.
 *
 * 🪤 **그렇다고 `- ` 전부로 넓히면 안 된다.** 실보드 실측:
 *   - 평면 구역(첫 `###` 이전) 최상위 불릿 30줄 — **전부 항목**, 부연 0줄.
 *   - 섹션 블록(`###` 이하 인계 서사) 최상위 불릿 294줄 — 그중 `- **` 159줄 외
 *     **135줄이 부연**이다(`- 검증: …` · `- 다음 에이전트: …` · `- ⚠️ **함정**…`).
 * 즉 넓히기의 이득 4줄과 대가 135줄이 **구역으로 정확히 갈린다**.
 *
 * ⛔ 형태(줄 생김새)로 가르려던 대안은 실측으로 기각했다. `이모지 + #번호` 를 항목의
 * 표식으로 삼으면 평면 구역의 진짜 항목 4줄 중 **2줄만** 잡고(산문형 2줄 누락), 섹션
 * 블록의 부연 **4줄을 새로 끌어온다** — 두 오류가 동시에 나빠진다. 부연 줄이 항목과
 * 같은 얼굴을 하고 있어서다(`- ✅ **머지 완료** …` 는 양쪽에 다 있다).
 *
 * 그래서 **구역이 기준이다**:
 *   - 평면 구역 = 항목 레지스트리(AGENTS.md 「활성 항목당 정확히 1줄」이 가리키는
 *     바로 그 구역). 형태를 묻지 않고 최상위 불릿 전부를 항목으로 본다.
 *   - 섹션 블록 = 인계 서사. 항목 레지스트리가 아니므로 넓히지 않고 **종전 `- **`
 *     그대로** 둔다.
 *
 * ⚖️ **두 오류의 균형을 어디에 뒀나:** 섹션 블록의 `- **` 159줄은 엄밀히는 항목이
 * 아니라 서사 줄이고, 지금 그것들이 대조 대상에 들어와 있다(부수적으로 좌표 없는
 * 항목 경고도 그 구역에서 다수 발생한다). 그럼에도 **빼지 않았다** — 빼는 것은
 * 커버리지를 줄이는 것이고 그 방향의 오류가 곧 침묵(미탐)이기 때문이다. 이 판정기의
 * 기존 원칙은 "거짓 경보가 낡은 마커보다 해롭다"(설계 원칙 3)지만, 그 원칙은
 * **종료코드를 흔드는 거짓 경보**에 대한 것이다. 섹션 블록에서 나오는 것은 대부분
 * `LEGACY_ARCHIVED`(구 레포 번호)이거나 종료코드에 반영되지 않는 경고라 사람을
 * 무디게 만드는 힘이 약하다. 반면 항목이 스캔에서 빠지는 것은 **경고 자체가 없어서**
 * 무디게 만들 것조차 없다. 그래서 이번 변경은 **넓히는 방향으로만** 움직이고,
 * 섹션 블록을 좁히는 판단은 별건으로 남긴다.
 *
 * 🛑 **여기서 멈춘다 — 이 다음 한 걸음이 함정이다.** 새 형식은 PR 을 링크가 아니라 맨
 * 번호로 적는다(`- ✅ #7 #8 #9 …`). 그래서 이 줄들은 **항목으로는 잡히지만 PR 대조는
 * 여전히 안 된다** — `primaryPr` 이 `pull/N` 링크만 읽기 때문이다. 그걸 "덜 고친 것"으로
 * 보고 맨 `#번호` 도 읽게 넓히지 말 것: 이 레포는 이관이 두 번이라 번호가 세 겹이고,
 * **번호만으로는 어느 레포인지 가릴 수 없다.** 그렇게 했던 판정이 실보드 26건을 전부
 * `PR_NOT_FOUND` 로 띄웠다(실측 2026-08-29, 진짜 드리프트는 0건 — 위 LEGACY_REPO_SLUGS
 * 주석). 링크 없는 항목의 안전망은 PR 대조가 아니라 `findCoordinatelessItems` 쪽이다.
 */

/** 평면 구역의 항목 줄 — 최상위 불릿이면 형태 불문 항목이다(위 주석). */
function isFlatItemLine(line) {
  return line.startsWith("- ") && line.trim().length > 2;
}

/** 섹션 블록에서 항목으로 인정하는 형태 — 종전 기준 유지(위 주석의 ⚖️). */
function isSectionItemLine(line) {
  return line.startsWith("- **");
}

/** 보드의 항목 줄 전부(PR 유무 무관). 구역별 기준은 위 주석. */
export function boardItemLines(text) {
  const { flat, sections } = splitBoardRegions(text);
  const lines = [
    ...flat.filter(({ line }) => isFlatItemLine(line)),
    ...sections.flatMap((s) => s.lines.filter(({ line }) => isSectionItemLine(line))),
  ];
  return lines.sort((a, b) => a.lineNumber - b.lineNumber);
}

/**
 * 보드 텍스트에서 항목 줄을 뽑는다. 항목은 `- **` 로 시작하는 최상위 불릿이고,
 * PR 링크(`pull/NNN`)를 가진 것만 대조 대상이다(PR 없는 서술 항목은 판정 불가).
 *
 * ⚠️ PR 없는 항목은 여기서 **의도적으로 빠진다** — gh·git 로 대조할 좌표가 없어서
 * 드리프트 판정 자체가 불가능하다. 다만 그게 곧 "위험이 없다"는 뜻은 아니다:
 * 아래 `findCoordinatelessItems` 가 그 사각을 별도로 본다.
 */
export function parseBoardItems(text) {
  const items = [];
  for (const { line, lineNumber } of boardItemLines(text)) {
    const resolved = primaryPr(line);
    if (resolved === null) continue; // PR 링크가 아예 없는 서술 항목 — 판정 불가
    items.push({
      lineNumber,
      // 제목 = 첫 마커부터 PR 링크 직전까지. 보고서에서 항목을 사람이 알아보게만 하면 된다.
      title: line.slice(0, 90).replace(/^- \*\*/, "").trim(),
      pr: resolved.pr,
      prConfident: resolved.confident,
      // 항목이 스스로 밝히는 레포(URL 슬러그). 없으면 현행 레포다 — 위 primaryPr.
      repo: resolved.repo,
      legacy: resolved.repo !== REPO_SLUG,
      claims: readClaims(line),
    });
  }
  return items;
}

/**
 * 항목이 **보드 밖의 두 번째 사본**을 가리키는가.
 *
 * AGENTS.md 보드 아키텍처는 활성 항목마다 상세 파일을 요구한다("항목 상세 =
 * `docs/handoff/<slug>.md`, 항목당 1파일"). 착지 후 `docs/archive/handoff/` 로
 * 옮겨가므로 두 경로를 모두 인정한다.
 *
 * `PROJECT_LOG` 참조도 인정한다 — 실보드에 "상세는 `PROJECT_LOG` 2026-07-23 두 줄"
 * 처럼 로그를 직접 가리키는 항목이 있고, 그건 파일이 달라 **이미 이중화된 것**이다.
 * 여기서 오탐을 내면 사람이 이 경고를 무시하게 되므로 인정 범위를 넓게 잡는다
 * (이 도구의 기존 원칙 — 거짓 경보가 낡은 마커보다 해롭다).
 *
 * ⚠️ 두 사본 모두 여전히 git 미추적이다. 이 판정은 "**한 줄 유실**에 견디는가"를
 * 보는 것이고, 파일 전체 유실까지 막지는 못한다 — 그건 별개 문제다.
 */
export function hasDurableReference(line) {
  return (
    /docs\/(?:archive\/)?handoff\/[^)\s]+\.md/.test(line) || /PROJECT_LOG/.test(line)
  );
}

/**
 * 항목에 **열린 게이트**(아직 할 일)가 남아 있는가.
 *
 * ⚠️ **줄 전체를 본다 — 상태 문구가 아니다(실측 2026-08-05).** 이 보드는 게이트를 상태
 * 문구가 아니라 **본문에** 적는 것이 관례다(`✅ 머지·승격·prod 배포 완료 … 다음 게이트 =
 * **오너 실작업: 실명 입력**`). 상태 문구만 보면 그런 항목이 "닫혔다"로 잡히고, 수명주기
 * 스윕(종결 → 로그 이관 → 보드에서 줄 제거)에 **살아 있는 항목이 딸려 나간다**.
 *
 * 🪤 **부정어를 반드시 본다.** `다음 게이트 없음` · `다음 게이트 = **없음(종결)**` 은 게이트가
 * **아니다**. 낱말만 찾던 종전 판정은 이걸 "게이트 있음"으로 읽어, 진짜 종결 항목을 영영
 * 안 닫힌 것으로 봤다(실측 위음성 1건).
 */
const GATE_MARK = /다음\s*게이트|잔여/;

export function hasOpenGate(text) {
  for (const m of text.matchAll(/다음\s*게이트|잔여/g)) {
    const rest = text.slice(m.index + m[0].length).replace(/^[\s=:*·—-]+/, "");
    if (/^없(?:음|다|고)/.test(rest)) continue; // "게이트 없음" 은 게이트가 아니다
    return true;
  }
  return false;
}

/**
 * 항목이 이미 닫힌 것인가(로그 이관 대기).
 *
 * 닫힌 항목은 유실돼도 `PROJECT_LOG.md` 로 복구되므로 좌표 위험이 아니다 — 대신 열린
 * 게이트가 있으면 아직 살아 있는 항목이다(완료 서술과 잔여가 한 줄에 같이 오는 것이 이
 * 보드의 관례다: `머지 완료 / 잔여=승격`).
 *
 * 🪤 **괄호 안 하위 절의 종결 낱말은 항목 전체의 종결이 아니다(실측 2026-08-05).**
 * `📦 배칭 대기 큐 (⛔ 종전 "단독 PR 금지" 는 전제 소멸)` · `🟡 트래픽 위생 존치(다운
 * 임박은 ⛔SUPERSEDED)` — 둘 다 **활성 항목**인데 괄호 안 `⛔` 때문에 종결로 잡혔다.
 * 항목의 상태 주장은 괄호 **밖**에 있고 괄호 안은 부연이다. 그래서 마커를 찾기 전에
 * 괄호 절을 걷어낸다(상태 문구가 ` — ` 에서 잘려 괄호가 안 닫힌 경우도 끝까지 걷는다).
 *
 * 오탐 방향이 비대칭이라는 점이 이 판정의 설계 근거다 — "살아 있는데 닫혔다"고 하면
 * 스윕이 남의 줄을 지우고(2026-07-31 실사고 형태, 되돌릴 이력 없음) "닫혔는데 살았다"고
 * 하면 줄이 조금 더 남을 뿐이다. 모호하면 **살아 있는 쪽**으로 판정한다.
 */
export function isClosedItem(line) {
  const status = statusPhrase(line);

  // 우선순위: 상태 문구가 게이트를 **언급하면** 그것이 항목 자신의 최신 주장이다.
  // 침묵할 때만 본문을 본다.
  //
  // ⚠️ 이 우선순위가 없으면 실보드에서 **종결 후보가 0건이 된다(실측)**. 완료된 항목의
  // 본문은 착지까지의 경과를 그대로 안고 있어서 **과거 게이트 선언이 서술로 남는다**
  // (`… 다음 게이트 = **오너: CI 3종 통과 확인 후 머지**` 가 이미 머지된 항목의 본문에
  // 그대로 있다). 본문을 무조건 우선하면 그 낡은 서술이 전부 "살아 있는 게이트"가 되어
  // 아무것도 닫히지 않고, 판정기가 조용히 무용지물이 된다.
  if (GATE_MARK.test(status)) {
    if (hasOpenGate(status)) return false;
    // 상태 문구가 "다음 게이트 없음"을 **명시**했다 — 본문의 낡은 서술보다 우선한다.
  } else if (hasOpenGate(line)) {
    return false; // 상태 문구는 침묵하는데 본문이 게이트를 선언한다 = 살아 있다
  }

  return /✅|⛔|종결|SUPERSEDED/.test(status.replace(/\([^)]*\)?/g, " "));
}

/**
 * **좌표 없는 항목** — PR 링크도 상세 파일 링크도 없는 활성 항목.
 *
 * ⚠️ 왜 별도로 보나(실사고 2026-07-30): 한 세션이 보드를 **배열 인덱스로 치환**해
 * 타 세션 줄을 덮어썼다. 보드는 git 미추적이라 되돌릴 이력이 없다. 그때 피해 범위를
 * 조사했더니 **PR 링크가 있는 항목은 전부 대조로 확인**됐지만(gh·`PROJECT_LOG`),
 * PR 도 상세 파일도 없는 항목은 **사라졌는지조차 확인할 방법이 없었다** — 대조할
 * 좌표가 아예 없기 때문이다. 오너 결정/육안 확인 큐처럼 한 줄로만 사는 항목들이다.
 *
 * 이 함수는 그 부류를 세어 보여준다. **드리프트로 세지 않는다**(종료코드 불변) —
 * 도입 시점에 수십 건이 걸려 즉시 실패로 뜨면 이 도구 자신의 원칙("거짓 경보를 내면
 * 사람이 점검기를 무시한다")을 어긴다. 백로그가 빠진 뒤 차단으로 승격할지는 오너 판단.
 */
export function findCoordinatelessItems(text) {
  const { flat, sections } = splitBoardRegions(text);
  const found = [];

  const record = ({ line, lineNumber }) =>
    found.push({
      lineNumber,
      title: line.slice(0, 90).replace(/^- \*\*/, "").trim(),
    });

  // 평면 구역: 줄 하나가 곧 항목이다 — 줄 단위로 판정한다.
  // 항목 인정 범위는 boardItemLines 와 같은 술어를 쓴다 — 여기만 좁으면 대조에는
  // 들어온 항목이 좌표 경고에서만 조용히 빠진다(같은 침묵 실패의 반쪽).
  for (const entry of flat) {
    if (!isFlatItemLine(entry.line)) continue;
    if (primaryPr(entry.line) !== null) continue;
    if (hasDurableReference(entry.line)) continue;
    if (isClosedItem(entry.line)) continue;
    record(entry);
  }

  // 섹션 블록: 헤더·형제 줄까지 함께 본다(아래 splitBoardRegions 주석의 오탐 사유).
  for (const section of sections) {
    const whole = [section.heading, ...section.lines.map((e) => e.line)].join("\n");
    if (/pull\/\d+/.test(whole) || hasDurableReference(whole)) continue;
    for (const entry of section.lines) {
      if (!isSectionItemLine(entry.line)) continue;
      if (isClosedItem(entry.line)) continue;
      record(entry);
    }
  }

  return found.sort((a, b) => a.lineNumber - b.lineNumber);
}

/**
 * 보드를 **평면 구역**(첫 `###` 이전)과 **섹션 블록**(`###` 이하)으로 가른다.
 *
 * ⚠️ **이 구분이 없으면 오탐이 난다(실측 2026-07-31).** 이 보드는 두 형식을 쓴다:
 *  - 평면 구역 — `- **상태 — 제목 [PR #N]**: … · 세션=xxx` 한 줄이 곧 한 항목이다.
 *  - 섹션 블록 — `### 날짜 · 세션 xxx` 헤더 아래 `종결 2건` · `남은 게이트` ·
 *    `다음 후보` 같은 불릿이 딸린 **인계 묶음**이다. 귀속(세션)은 헤더에, 참조는
 *    형제 줄에 있다.
 *
 * 줄 단위로만 보면 섹션 블록의 불릿이 "PR 도 상세 파일도 없다"로 잡힌다 — 실제로
 * `남은 게이트`·`다음 후보` 두 줄이 그렇게 걸렸다. 그런데 그 블록은 헤더가 세션을
 * 밝히고 형제 줄이 `PR #155`·`PROJECT_LOG` 를 가리키므로 **한 줄이 유실돼도 복구
 * 경로가 남는다** — 이 경고가 재는 바로 그 조건이다.
 *
 * 거짓 경보는 낡은 마커보다 해롭다는 것이 이 도구의 원칙인데, 그 원칙을 이 도구
 * 자신이 어기고 있었다. 그래서 블록은 **블록 단위로** 판정한다.
 *
 * 경계를 `###` 로 잡는 근거: 실보드에서 평면 항목 68건이 전부 첫 `###` 이전에
 * 있고, 이후 7건이 전부 두 인계 블록의 구성 요소다(실측). 평면 구역을 한 블록으로
 * 묶으면 PR 하나가 68건을 전부 덮어버리므로 **반대로 위험하다** — 그래서 첫 `###`
 * 이전은 반드시 줄 단위를 유지한다.
 */
export function splitBoardRegions(text) {
  const flat = [];
  const sections = [];
  let current = null;

  text.split("\n").forEach((line, i) => {
    if (line.startsWith("###")) {
      current = { heading: line, lines: [] };
      sections.push(current);
      return;
    }
    const entry = { line, lineNumber: i + 1 };
    if (current) current.lines.push(entry);
    else flat.push(entry);
  });

  return { flat, sections };
}

/**
 * 항목의 **주 PR**: 헤더 안의 **마지막** PR 링크. 헤더에 링크가 없으면 본문에서 추정한다.
 *
 * 보드 헤더는 `상태 — 제목 [PR #N]` 순서라 제목에 붙은 마지막 링크가 그 항목의 PR 이다.
 * "첫 링크"로 잡으면 상태 문구가 참조하는 **다른** PR 을 주 PR 로 오인한다(실제로
 * `🟢 M1 머지 완료 / 후속 [PR #124] … — … M1 [PR #120]` 에서 #120 대신 #124 를 잡아
 * M1 서술을 덮어쓸 뻔했다).
 *
 * 🔑 헤더 경계를 `- **…**` 의 **첫 닫는 `**`** 로 잡으면 안 된다 — 보드 헤더에는 강조용
 * 중첩 볼드(`알림센터 **전면 해체** → …`)가 흔해서 헤더가 앞쪽에서 잘리고, 그 뒤의 PR
 * 링크를 못 봐 **항목이 통째로 조용히 스킵된다**(실측: 35건 중 8건이 그렇게 누락됐다 —
 * 낡은 마커를 못 잡는 것보다 나쁜, 점검기 자신의 침묵 실패다).
 * 그래서 경계는 본문 구분자 `**:` 로 잡고, 없으면 줄의 마지막 `**` 로 잡는다.
 *
 * 헤더에 링크가 하나도 없는 항목(본문에만 PR 을 적은 옛 항목)은 **건너뛰지 않고**
 * 본문 링크로 추정하되 `confident: false` 로 표시해 보고서에서 확인을 요청한다.
 */
function headerEndOf(line) {
  const bodyMark = line.indexOf("**:");
  const lastMark = line.lastIndexOf("**");
  return bodyMark >= 0 ? bodyMark : lastMark > 3 ? lastMark : line.length;
}

/**
 * 항목의 **상태 문구** = 헤더에서 첫 ` — ` 앞까지(없으면 헤더 전체).
 *
 * 항목이 "지금 무엇을 기다리는가"라는 **주장**은 여기에만 적힌다. 본문·게이트 서술에
 * 나오는 같은 낱말은 서술이지 주장이 아니다 — 줄 전체에서 읽으면 설명문이 주장으로
 * 오독된다(실측: 워처를 설명하는 `세션이 머지대기→await-promotion.sh…` 문구 때문에
 * 이미 머지된 자기 항목이 '낡은 대기 마커'로 잡혔다. 점검기가 거짓 경보를 내면
 * 사람이 점검기를 무시하게 되므로, 낡은 마커를 놓치는 것만큼 해롭다).
 */
export function statusPhrase(line) {
  const header = line.slice(0, headerEndOf(line)).replace(/^- \*\*/, "");
  const sep = header.indexOf(" — ");
  return sep >= 0 ? header.slice(0, sep) : header;
}

/**
 * PR 링크에서 **번호와 레포를 함께** 읽는다.
 *
 * 🔑 **레포 식별 정보는 이미 보드 안에 있다.** 규약(P6·codebase-map)은 구 레포 번호를
 * `구레포#188(4e67fe6)` 로 한정하라고 하지만, 실보드는 그보다 강한 것을 이미 쓰고 있다 —
 * 실측 2026-08-29 기준 보드의 PR 링크 **83건 전부**가 `github.com/<owner>/<repo>/pull/N`
 * 풀 URL 이고 슬러그가 100% 균일했다. 그래서 사람이 26줄을 손으로 고칠 필요가 없다:
 * **보드는 그대로 두고 점검기가 링크를 읽으면 된다.**
 *
 * 이 선택이 중요한 이유는 정확성이 아니라 **안전**이다 — 보드는 git 미추적·다세션 공유
 * 파일이라 되돌릴 이력이 없고, 26회 치환은 그 자체로 P0 위험이다(2026-07-30 덮어쓰기
 * 실사고: 한 세션이 타 세션 줄을 덮어썼고 무엇이 지워졌는지조차 확정하지 못했다).
 *
 * 슬러그가 없는 맨 `pull/N` 은 현행 레포로 본다 — 새로 쓰는 항목의 기본값이다.
 */
const PR_LINK = /(?:github\.com\/([\w.-]+\/[\w.-]+)\/)?pull\/(\d+)/g;

function prLinksIn(line) {
  return [...line.matchAll(PR_LINK)].map((m) => ({
    index: m.index,
    pr: Number(m[2]),
    repo: m[1] ?? REPO_SLUG,
  }));
}

export function primaryPr(line) {
  const headerEnd = headerEndOf(line);
  const all = prLinksIn(line);
  if (all.length === 0) return null;

  const inHeader = all.filter((m) => m.index < headerEnd);
  const chosen = inHeader.length > 0 ? inHeader[inHeader.length - 1] : all[all.length - 1];
  return { pr: chosen.pr, repo: chosen.repo, confident: inHeader.length > 0 };
}

/**
 * 항목 줄이 스스로 주장하는 상태를 읽는다. 마커 이모지가 아니라 문구가 SSOT 다.
 *
 * ⚠️ 여기 판정은 실제 보드에 돌려 오탐을 잡아가며 좁힌 것이다 — 넓히지 말 것:
 *  - `머지 대기` 는 **상태 문구 안에 있을 때만** 주장으로 센다(위 `statusPhrase` 주석).
 *  - `배포 확인` 이 **잔여 게이트 안에 있을 때만** 대기로 센다. 줄 어딘가에 "잔여=…" 가
 *    있다는 이유로 완료 서술(`머지·prod 배포 확인(sha)`·`배포 확인 완료`)까지 대기로 읽으면
 *    끝난 항목이 영원히 드리프트로 뜬다(#88·#92 가 그렇게 오탐됐다).
 *  - **데모 레인 배포는 prod 승격과 다른 축이다**(P6 운영 release / 데모 demo) — 데모 첫
 *    배포를 기다리는 항목을 prod 미배포로 읽으면 안 된다.
 */
// 게이트 서술의 끝은 글자 수가 아니라 **구분자**로 잡는다. 고정 창(N자)으로 자르면 같은
// 문장이라도 항목 길이에 따라 판정이 뒤집힌다(첫 구현이 실제로 그랬다 — 실보드에서는
// 우연히 통과하고 축약 픽스처에서는 오탐).
const GATE_END = /\s[—·]\s|\*\*|$/;
const GATE_CAP = 200; // 구분자가 없는 항목 대비 안전 상한

/**
 * 상태 문구가 **머지를 기다린다**고 주장하는가.
 *
 * 🪤 **어순 의존이 위음성을 낳았다(실측 2026-08-05).** 원래 판정은 `/머지\s*대기/` 하나였는데,
 * 실보드가 쓰는 최신 문구는 어순이 반대다 — `⏳ CI 대기 → 오너 머지`. "대기"가 "머지" **앞**에
 * 있어 매치하지 않았고, `awaitingMerge` 가 영영 false 라 `STALE_MERGE_MARKER` 가 **발화 자체를
 * 못 했다**. 실제로 PR 2건이 머지·prod 반영까지 끝났는데 보드는 그 문구로 남아 있었고
 * `npm run board:check` 는 "드리프트 없음"을 보고했다 — 정정 전후로 **출력이 완전히 동일**했다.
 * 이 도구가 막으려고 만들어진 바로 그 사고(2026-07-29)를 이 문구에 대해서만 재현한 셈이다.
 *
 * 그래서 어순 비의존으로 넓히되, **완료 서술은 반드시 뺀다**. 실보드에서 압도적으로 흔한 형태가
 * `🚀 머지 완료 → 승격 대기` · `✅ 머지·승격·prod 배포 완료` 라서, 넓히기만 하면 그쪽이 전부
 * 낡은 마커로 뜬다 — 거짓 경보는 낡은 마커보다 해롭다는 것이 이 도구의 원칙이다(위 설계 원칙 3).
 */
const WAIT_SIGNAL = /대기|⏳|🔴/;

/**
 * "오너 리뷰 대기" — "PR 생성 · 오너 리뷰 대기" 처럼 머지 전 상태를 가리키는 관용구인데
 * "머지"라는 글자가 아예 없다(실사고 2026-08-08 아침 브리핑 — PR 3건이 머지+prod
 * 배포까지 끝났는데 이 문구로 남아 있어 `머지` 필수 검사에 걸려 STALE_MERGE_MARKER 가
 * 발화 자체를 못 했다). "대기"가 뒤따를 때만 매치해 "오너 리뷰 완료" 류를 과대 매치하지
 * 않는다.
 */
const OWNER_REVIEW_WAIT = /오너\s*(?:리뷰|검토)\s*대기/;

/**
 * "승격 대기"/"승격(배포) 대기" — 머지 완료 문구와 함께 오는 승격(prod 배포) 대기
 * 관용구다(같은 실사고). 기존 pendingDeploy 는 `잔여`/`다음 게이트` 라벨이 붙은
 * 세그먼트 안에서만 "배포 확인"을 찾아, 상태 문구 자체에 실린 이 표현을 놓쳤다.
 * "대기"가 뒤따를 때만 매치해 "승격 완료" 류를 과대 매치하지 않는다.
 */
const PROMOTION_WAIT = /승격\s*(?:\([^)]*\)\s*)?대기/;

/**
 * 머지가 **이미 끝났다**는 서술. 두 갈래를 다 덮어야 한다:
 *  ⓐ 완료 낱말이 붙은 것 — `머지 완료` · `머지됨` · `머지·승격` · `머지·prod`
 *  ⓑ 완료 낱말 없이 **다음 단계로 넘어간 것** — `머지 → 승격 대기` · `머지 후 배포 확인`
 *
 * 🪤 **ⓑ 를 빠뜨려 회귀를 냈다(실측 2026-08-05, PR #288 직후).** 제외 목록이 `머지 완료`
 * 형태만 덮어서, `완료` 없이 `머지 → 승격 대기` 로 쓴 줄이 "아직 머지 대기"로 읽혔다.
 * 그건 머지가 끝나고 **배포를 기다리는** 상태라 `AWAITING_DEPLOY`(정상)로 가야 하는데
 * `awaitingMerge` 가 그 분기를 가로채 `STALE_MERGE_MARKER` 를 냈다 — 실보드에서 종료코드 3
 * 이 상시로 떴고, 잡힌 대상이 하필 그 수정 자신의 보드 줄이었다.
 *
 * 그래서 판정을 어휘 목록이 아니라 **의미**로 잡는다: `머지` 뒤에 다음 단계(승격·배포·prod)가
 * 오면 그건 머지 대기가 아니다. 상시 거짓 경보는 사람이 점검기를 무시하게 만들고, 그게 애초에
 * 이 스크립트가 막으려던 실패 양식이다(설계 원칙 3).
 */
const MERGE_DONE =
  /머지\s*(?:완료|됨|끝)|머지\s*[·・]|머지\s*(?:→|->|~>|후|뒤)\s*[^—]*?(?:승격|배포|prod)/;

export function claimsAwaitingMerge(status) {
  if (/머지\s*대기/.test(status)) return true; // 고전 어순 — 그대로 유지(회귀 방지)
  if (OWNER_REVIEW_WAIT.test(status)) return true; // "머지" 글자 없이 대기를 주장하는 관용구
  if (!/머지/.test(status)) return false;
  if (MERGE_DONE.test(status)) return false; // `머지 완료 → 승격 대기` 는 대기 주장이 아니다
  return WAIT_SIGNAL.test(status);
}

const DEPLOYED_RE =
  /(?:prod\s*)?(?:배포|착지)\s*(?:확인\s*)?완료|prod\s*(?:라이브|착지|반영)|배포\s*완료/;

/**
 * 보드가 **배포까지 끝났다고 주장**하는가.
 *
 * 🪤 **줄 전체에서 읽으면 본문 서술이 주장으로 오독된다(실측 2026-08-05).** 이 항목의 본문에
 * 다른 PR 의 경과나 검증 서술로 `prod 반영`·`배포 완료` 가 들어 있으면, 상태 문구가 `🚀 머지
 * 완료 → 승격 대기` 라고 **명시**하는데도 `OVERCLAIMED_DEPLOY`(과대보고)가 났다 — 보드는 옳고
 * 판정기가 틀린 상태로 종료코드 3 이 상시 발화했다. `awaitingMerge`·`isClosedItem` 이 이미
 * 겪은 것과 **같은 계열의 마지막 잔여분**이다("주장은 상태 문구에만 있다").
 *
 * 다만 여기서는 **본문을 통째로 버릴 수 없다.** 과대보고는 낡은 마커보다 위험하다는 것이
 * 설계 원칙 3 이라, 상태 문구가 침묵하는 항목의 본문 배포 주장까지 놓치면 탐지력이 준다.
 * 그래서 `isClosedItem` 과 같은 **우선순위**로 푼다:
 *   ① 상태 문구가 배포를 주장하면 → 주장이다(가장 강한 신호).
 *   ② 상태 문구가 **아직 승격 전**이라고 명시하면(`머지 완료 → 승격 대기`·머지 대기) →
 *      본문 서술은 주장이 아니다. 항목 자신의 최신 선언이 본문 경과를 이긴다.
 *   ③ 상태 문구가 배포에 침묵하면 → 본문까지 본다(과대보고 탐지력 보존).
 */
export function claimsDeployed(line) {
  const status = statusPhrase(line);
  if (DEPLOYED_RE.test(status)) return true;
  if (claimsAwaitingMerge(status)) return false;
  if (MERGE_DONE.test(status) && WAIT_SIGNAL.test(status)) return false; // 승격 대기 명시
  return DEPLOYED_RE.test(line);
}

export function readClaims(line) {
  const gateSegments = [...line.matchAll(/(잔여|다음\s*게이트)/g)].map((m) => {
    const rest = line.slice(m.index, m.index + GATE_CAP);
    const end = rest.slice(1).search(GATE_END);
    return end >= 0 ? rest.slice(0, end + 1) : rest;
  });
  const pendingDeployInGate = gateSegments.some((seg) =>
    [...seg.matchAll(/(데모\s*(첫\s*)?)?(승격\s*)?배포\s*확인(\s*완료)?/g)].some((m) => !m[4] && !m[1]),
  );
  // "승격 대기"/"승격(배포) 대기" 는 잔여 게이트 라벨 없이 상태 문구에 직접 실리기도 한다
  // (2026-08-08 실사고) — 그 경우도 배포 대기 자백으로 센다.
  const pendingDeploy = pendingDeployInGate || PROMOTION_WAIT.test(statusPhrase(line));
  return {
    // 머지 대기 주장은 **상태 문구**에 적혔을 때만 센다(본문의 같은 낱말은 서술).
    awaitingMerge: claimsAwaitingMerge(statusPhrase(line)),
    // "배포 확인"이 **잔여 게이트로** 적혔거나 "승격 대기"가 상태 문구에 있으면
    // 아직 prod 에 없다는 자백이다.
    awaitingDeploy: pendingDeploy,
    // 배포 주장도 상태 문구가 우선이다 — 본문은 상태 문구가 침묵할 때만 본다.
    deployed: claimsDeployed(line),
  };
}

export const VERDICT = {
  OK: "OK",
  STALE_MERGE_MARKER: "STALE_MERGE_MARKER",
  OVERCLAIMED_DEPLOY: "OVERCLAIMED_DEPLOY",
  UNKNOWN_SHA: "UNKNOWN_SHA",
  // ⛔ 종전 이름 `AWAITING_PROMOTION` 은 2026-08-15 레인 교체로 개명했다 — 기다리는 대상이
  // Vercel 승격이 아니라 **셀프호스트 배포**(`deploy.sh`)라, 옛 이름을 두면 다음 사람이
  // `origin/release` 를 들여다보게 된다(이 결함이 정확히 그렇게 났다).
  AWAITING_DEPLOY: "AWAITING_DEPLOY",
  // 배포 축을 **판정할 수 없다**(마커 부재·판독 불가). 미배포가 아니다 — 설계 원칙 2.
  DEPLOY_UNVERIFIABLE: "DEPLOY_UNVERIFIABLE",
  PR_NOT_FOUND: "PR_NOT_FOUND",
  // 구 레포(읽기 전용 아카이브) 항목. 머지까지는 확인되고 배포 축은 **원천 대조 불가**다 —
  // 이관이 이력을 재작성했기 때문이지 무언가 잘못돼서가 아니다(정상 상태, 드리프트 아님).
  LEGACY_ARCHIVED: "LEGACY_ARCHIVED",
};

/** 드리프트로 세는 판정(= 사람이 보드를 고쳐야 하는 것). */
export const DRIFT_VERDICTS = new Set([
  VERDICT.STALE_MERGE_MARKER,
  VERDICT.OVERCLAIMED_DEPLOY,
  VERDICT.PR_NOT_FOUND,
]);

/**
 * 항목 1건 판정. fact = { state, merged, sha, shaKnown, inMain, inProd }.
 *
 * 🔑 **`inProd` 는 3-상태다**(`true`/`false`/`null`) — boolean 이 아니다. `null` 은 셀프호스트
 * 배포 마커를 읽을 수 없어 **배포 축을 판정할 수 없다**는 뜻이고, `false`(미배포)와 섞으면
 * 클라우드 세션·fresh clone 에서 보드 전체가 "미배포"로 뒤집힌다(설계 원칙 2 정면 위반).
 * ⚠️ 그래서 `if (fact.inProd)` 같은 truthy 검사로 되돌리지 말 것 — `null` 이 조용히 미배포
 * 분기로 흘러든다. 세 갈래를 명시적으로 가른다.
 *
 * 🔑 "고아 SHA" 판정 기준은 `cat-file` 존재 여부가 **아니라 `inMain`** 이다. 히스토리
 * 재작성 후에도 옛 머지커밋 객체는 로컬에 한동안 남아 있어(reflog·GC 유예) 존재 검사는
 * 통과한다 — 그걸 근거로 "배포 마커 조상이 아니니 미배포"라고 하면 2026-07-21 이전 머지분
 * 전부가 거짓 경보가 된다(실제로 첫 실행에서 #45·#52·#54 가 그렇게 잡혔다).
 * 정상 머지된 PR 의 머지커밋은 **언제나 main 의 조상**이므로, main 에 없으면 그 SHA 는
 * 재작성으로 버려진 것이다.
 */
export function classifyItem(claims, fact) {
  if (!fact || fact.state === "NOT_FOUND") {
    return {
      verdict: VERDICT.PR_NOT_FOUND,
      detail:
        `PR 을 조회할 수 없다(${fact?.repo ?? REPO_SLUG}) — 번호 오기이거나, 링크의 레포` +
        ` 슬러그가 실제와 다르거나(이관이 두 번이라 번호가 세 겹이다), 조회 상한 밖일 수 있다`,
    };
  }

  if (!fact.merged) {
    // 아직 안 머지됐으면 "머지 대기" 마커가 정확한 것이다.
    return claims.awaitingMerge
      ? { verdict: VERDICT.OK, detail: "미머지 — 대기 마커가 정확하다" }
      : {
          verdict: VERDICT.OK,
          detail: `미머지(state=${fact.state}) — 대기 마커는 없지만 과대보고도 아니다`,
        };
  }

  /**
   * 구 레포 항목 — **머지 여부까지만 알 수 있다.**
   *
   * 이관이 이력을 재작성해 구 커밋은 현행 `main` 의 조상이 **아니다**(P6 Repo Migration —
   * `merge-base --is-ancestor` 가 항상 거짓). 그래서 SHA 대조는 원천 불가다.
   *
   * ⚠️ **이걸 `UNKNOWN_SHA` 로 뭉개지 않는 이유:** 그 판정의 사유는 "2026-07-21 히스토리
   * 재작성으로 **고아가 된**" 이라 사고 잔여물을 가리킨다. 이관은 사고가 아니라 정상
   * 상태이고, 실보드에서 이 부류가 26건이라 사유를 뭉개면 진짜 고아를 영영 구분할 수
   * 없다. 판정이 우연히 맞는 것과 사유가 맞는 것은 다르다.
   *
   * ⚠️ **그래도 낡은 대기 마커는 여기서도 잡는다.** 구 레포도 조회되므로 "머지 대기"라는
   * 주장의 진위는 판정 가능하고, 그 오류(완료된 작업에 재착수 지시)는 레포와 무관하게
   * 이 도구가 막으려는 바로 그 사고다.
   */
  if (fact.legacy) {
    return claims.awaitingMerge || claims.awaitingDeploy
      ? {
          verdict: VERDICT.STALE_MERGE_MARKER,
          detail: `구 레포(${fact.repo})에서 이미 머지됐는데 보드는 아직 대기라고 주장한다`,
        }
      : {
          verdict: VERDICT.LEGACY_ARCHIVED,
          detail: `구 레포(${fact.repo}) 항목 — 머지 확인됨. 이관으로 이력이 갈려 배포 축은 대조 불가(정상)`,
        };
  }

  // 여기부터는 현행 레포의 머지된 항목이다.
  if (!fact.shaKnown || !fact.inMain) {
    return {
      verdict: VERDICT.UNKNOWN_SHA,
      detail:
        "머지커밋이 main 이력에 없다(2026-07-21 main 히스토리 재작성으로 고아가 된 옛 SHA) — **미배포가 아니다**. 내용은 새 SHA 로 살아 있으므로 재착수 금지",
    };
  }

  // 배포 축을 모르는 환경(마커 부재·판독 불가). **머지 축만** 판정하고 배포는 침묵한다 —
  // 여기서 미배포로 단정하면 클라우드 세션이 멀쩡한 항목을 전부 승격 대기로 보고한다.
  if (fact.inProd === null || fact.inProd === undefined) {
    return claims.awaitingMerge
      ? {
          verdict: VERDICT.STALE_MERGE_MARKER,
          detail: "머지는 끝났는데 보드는 아직 머지 대기라고 주장한다(배포 여부는 판정 불가)",
        }
      : {
          verdict: VERDICT.DEPLOY_UNVERIFIABLE,
          detail: "머지 확인 · 배포 판정 불가(셀프호스트 배포 마커를 읽을 수 없다) — 미배포가 아니다",
        };
  }

  if (fact.inProd === true) {
    // 머지+배포 완료. 대기 마커가 남아 있으면 낡은 것이다.
    return claims.awaitingMerge || claims.awaitingDeploy
      ? {
          verdict: VERDICT.STALE_MERGE_MARKER,
          detail: "머지·prod 배포까지 끝났는데 보드는 아직 대기라고 주장한다",
        }
      : { verdict: VERDICT.OK, detail: "머지·prod 배포 완료 — 마커와 일치" };
  }

  // 머지됐지만 프로덕션 호스트에 아직 안 올라갔다 = 배포 대기(정상 — 배포는 수동 발화다).
  // 단 "배포 완료"라고 적혀 있으면 과대보고다.
  if (claims.deployed) {
    return {
      verdict: VERDICT.OVERCLAIMED_DEPLOY,
      detail:
        "보드는 배포 완료라는데 머지커밋이 셀프호스트 배포 마커의 조상이 아니다 — 아직 서버에 안 올라갔거나 배포가 실패했다(P0 환각 보고 방향)",
    };
  }
  return claims.awaitingMerge
    ? {
        verdict: VERDICT.STALE_MERGE_MARKER,
        detail: "머지는 끝났다(잔여는 서버 반영뿐) — 대기 마커가 낡았다",
      }
    : { verdict: VERDICT.AWAITING_DEPLOY, detail: "머지 완료·서버 반영 대기 — 정상(머지 ≠ 배포)" };
}

// ── 부수효과 레인(gh·git) ────────────────────────────────────────────────────

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** 보드 경로 탐색: 워크트리에서도 **메인 레포 루트의 단일 사본**을 본다(AGENTS.md 모드 L). */
export function resolveBoardPath(explicit) {
  if (explicit) return explicit;
  try {
    const first = sh("git", ["worktree", "list", "--porcelain"]).split("\n")[0];
    const root = first.replace(/^worktree /, "").trim();
    if (root) return path.join(root, "PROJECT_MASTER.md");
  } catch {
    /* git 밖이면 아래 폴백 */
  }
  return path.resolve("PROJECT_MASTER.md");
}

/** PR 상태를 한 번에 가져온다(항목마다 호출하면 수십 회 왕복이 된다). */
function fetchPullRequests(slug) {
  const raw = sh("gh", [
    "pr",
    "list",
    "-R",
    slug,
    "--state",
    "all",
    // ⚠️ `--limit` 은 **최신순 상한**이다 — 구 레포는 PR 이 500건을 넘어 옛 번호가 조용히
    // 빠졌다(실측). 빠진 번호는 `PR_NOT_FOUND` 로 뜨는데 그건 "번호 오기"가 아니라
    // **조회 범위 밖**이다(P9 「검증 판정 위생」의 3분법 ②) — 상한을 넉넉히 둔다.
    "--limit",
    "1000",
    "--json",
    "number,state,mergeCommit",
  ]);
  const map = new Map();
  for (const pr of JSON.parse(raw)) {
    map.set(pr.number, {
      state: pr.state,
      merged: pr.state === "MERGED",
      sha: pr.mergeCommit?.oid ?? null,
    });
  }
  return map;
}

function gitKnows(sha) {
  try {
    sh("git", ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestorOf(sha, ref) {
  try {
    sh("git", ["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 셀프호스트 배포 마커를 읽어 **판정 기준 커밋**을 정한다. 못 읽으면 `sha: null` 과
 * **사람이 읽을 사유**를 함께 돌려준다 — 사유 없이 조용히 판정을 끄면, 배포 축이 꺼진 채
 * 종료코드 0 이 나오는 것을 "드리프트 없음"으로 오독한다(과대보고 탐지가 함께 꺼진다).
 */
function resolveDeployBase() {
  const file = deployMarkerPath();
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { file, sha: null, reason: "마커 파일이 없다(이 기계가 프로덕션 호스트가 아니다 — 클라우드 세션·fresh clone 이면 정상)" };
  }
  const sha = parseDeployMarker(raw);
  if (!sha) return { file, sha: null, reason: "마커 파일을 읽었지만 커밋 SHA 형태가 아니다" };
  if (!gitKnows(sha)) {
    return { file, sha: null, reason: `마커가 가리키는 커밋(${sha.slice(0, 7)})을 이 체크아웃이 모른다 — fetch 범위 밖이거나 마커가 다른 레포를 가리킨다` };
  }
  return { file, sha, reason: null };
}

function buildFact(item, prInfo, deployBase) {
  // ⚠️ `inProd` 의 미판정값은 `false` 가 아니라 `null` 이다 — classifyItem 주석 참조.
  const empty = { shaKnown: false, inMain: false, inProd: null };
  const origin = { legacy: item.legacy, repo: item.repo };
  if (!prInfo) return { state: "NOT_FOUND", merged: false, sha: null, ...origin, ...empty };
  if (!prInfo.merged || !prInfo.sha) return { ...prInfo, ...origin, ...empty };
  // 구 레포는 이력이 갈려 SHA 대조가 무의미하다 — 조회하지 않는다(무의미한 git 왕복 제거).
  if (item.legacy) return { ...prInfo, ...origin, ...empty };
  const shaKnown = gitKnows(prInfo.sha);
  if (!shaKnown) return { ...prInfo, ...origin, ...empty };
  return {
    ...prInfo,
    ...origin,
    shaKnown,
    inMain: isAncestorOf(prInfo.sha, MAIN_REF),
    inProd: deployBase ? isAncestorOf(prInfo.sha, deployBase) : null,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const asJson = argv.includes("--json");
  const boardIdx = argv.indexOf("--board");
  const boardPath = resolveBoardPath(boardIdx >= 0 ? argv[boardIdx + 1] : undefined);

  if (!existsSync(boardPath)) {
    // 보드는 git 미추적 로컬 전용이다 — fresh clone·클라우드 세션엔 아예 없다(정상).
    if (!asJson) console.log(`ℹ️  보드가 없다(${boardPath}) — 점검 대상 없음. 로컬 전용 파일이라 정상이다.`);
    else console.log(JSON.stringify({ board: boardPath, skipped: true, results: [] }, null, 2));
    return 0;
  }

  const boardText = readFileSync(boardPath, "utf8");
  const items = parseBoardItems(boardText);
  // 좌표 없는 항목은 gh·git 왕복이 필요 없다 — 대조 대상이 0건이어도 보고한다.
  const coordinateless = findCoordinatelessItems(boardText);
  if (items.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ board: boardPath, results: [], coordinateless }, null, 2));
    } else {
      console.log("ℹ️  PR 링크를 가진 항목이 없다 — 대조 대상 없음.");
      printCoordinateless(coordinateless);
    }
    return 0;
  }

  try {
    // ⛔ `release` 는 더 이상 fetch 하지 않는다 — 배포 판정에서 빠졌다(위 deployMarkerPath).
    sh("git", ["fetch", "origin", "main", "-q"]);
  } catch (err) {
    console.error(`⛔ git fetch 실패 — main 이력을 모른 채로는 머지 판정을 못 한다: ${err.message}`);
    return 1;
  }

  const deploy = resolveDeployBase();

  // 항목이 밝힌 레포마다 한 번씩 조회한다 — 구 레포 항목은 아카이브에서 읽는다.
  const prMaps = new Map();
  for (const slug of new Set(items.map((i) => i.repo))) {
    try {
      prMaps.set(slug, fetchPullRequests(slug));
    } catch (err) {
      console.error(`⛔ gh 조회 실패(${slug} — 로그인·네트워크·접근권한 확인): ${err.message}`);
      return 1;
    }
  }

  const results = items.map((item) => {
    const fact = buildFact(item, prMaps.get(item.repo)?.get(item.pr), deploy.sha);
    const { verdict, detail } = classifyItem(item.claims, fact);
    return { ...item, fact, verdict, detail };
  });

  if (asJson) {
    console.log(JSON.stringify({ board: boardPath, deploy, results, coordinateless }, null, 2));
  } else {
    printReport(boardPath, results, deploy);
    printCoordinateless(coordinateless);
  }

  // ⚠️ 좌표 없는 항목은 종료코드에 반영하지 않는다 — 위 findCoordinatelessItems 주석 참조.
  return results.some((r) => DRIFT_VERDICTS.has(r.verdict)) ? 3 : 0;
}

/**
 * 좌표 없는 항목 보고. **경고이지 실패가 아니다**(종료코드 불변).
 *
 * 이 목록의 항목은 보드 줄이 유실되면 **어디에도 흔적이 남지 않는다** — PR 번호도
 * 상세 파일도 없어서 `gh` 로도 `PROJECT_LOG.md` 로도 재구성할 수 없다.
 * 조치는 둘 중 하나: 상세 파일(`docs/handoff/<slug>.md`)을 만들거나, 항목이 이미
 * 끝난 것이면 로그로 이관하고 보드에서 뺀다.
 */
function printCoordinateless(items) {
  if (items.length === 0) {
    console.log("\n🧷 좌표 없는 항목 0건 — 모든 활성 항목이 PR 이나 상세 파일로 이중화돼 있다.");
    return;
  }
  console.log(
    `\n🧷 좌표 없는 항목 ${items.length}건 — PR 번호도 상세 파일도 없다(유실 시 복구 불가):`,
  );
  for (const item of items) console.log(`  L${item.lineNumber} · ${item.title}`);
  console.log(
    "   → 보드는 git 미추적이라 줄이 덮어써지면 되돌릴 이력이 없다(2026-07-30 실사고).",
  );
  console.log(
    "   → 조치: `docs/handoff/<slug>.md` 를 만들어 링크하거나, 끝난 항목이면 `PROJECT_LOG.md` 로 이관하고 보드에서 뺀다.",
  );
  console.log("   → 이 경고는 종료코드에 반영되지 않는다(차단 아님).");
}

function printReport(boardPath, results, deploy) {
  const by = (v) => results.filter((r) => r.verdict === v);
  const drift = results.filter((r) => DRIFT_VERDICTS.has(r.verdict));

  console.log(`보드: ${boardPath}`);
  if (deploy.sha) {
    console.log(`배포 기준: ${deploy.file} = ${deploy.sha.slice(0, 7)} (셀프호스트 프로덕션이 서빙 중인 커밋)`);
  } else {
    // 배포 축이 꺼진 채 "드리프트 없음"이 나오는 것을 정상으로 오독하지 않게 **먼저** 말한다.
    console.log(
      `⚠️ 배포 판정 불가 — ${deploy.reason}\n` +
        `   (${deploy.file})\n` +
        `   → 머지 축만 판정한다. **미배포로 단정하지 않으며**, 이 상태에서는 과대보고(배포 완료 주장) 탐지도 함께 꺼진다.`,
    );
  }
  console.log(`대조 항목: ${results.length}건 (PR 링크 있는 항목만)\n`);

  for (const [label, verdict] of [
    ["🔺 낡은 대기 마커 — 이미 머지/배포됐다", VERDICT.STALE_MERGE_MARKER],
    ["🚨 과대보고 — 배포 완료라는데 프로덕션 서버에 없다", VERDICT.OVERCLAIMED_DEPLOY],
    ["❓ PR 조회 불가", VERDICT.PR_NOT_FOUND],
  ]) {
    const rows = by(verdict);
    if (rows.length === 0) continue;
    console.log(`${label} (${rows.length}건)`);
    for (const r of rows) console.log(`  L${r.lineNumber} #${r.pr} · ${r.title}\n      → ${r.detail}`);
    console.log("");
  }

  const pending = by(VERDICT.AWAITING_DEPLOY);
  if (pending.length) {
    console.log(
      `⏳ 서버 반영 대기(정상 — 머지 ≠ 배포) ${pending.length}건: ${pending.map((r) => `#${r.pr}`).join(" ")}`,
    );
  }
  const unverifiable = by(VERDICT.DEPLOY_UNVERIFIABLE);
  if (unverifiable.length) {
    console.log(
      `🌫️ 배포 판정 불가 ${unverifiable.length}건: ${unverifiable.map((r) => `#${r.pr}`).join(" ")}` +
        `\n   → 머지는 확인됐고 배포 여부만 모른다. **미배포가 아니다** — 재착수 금지.`,
    );
  }
  const legacy = by(VERDICT.LEGACY_ARCHIVED);
  if (legacy.length) {
    console.log(
      `🗄️ 구 레포 항목 ${legacy.length}건(머지 확인됨 · 배포 축은 원천 대조 불가 — 정상):` +
        ` ${legacy.map((r) => `${r.repo.split("/")[1]}#${r.pr}`).join(" ")}` +
        `\n   → 이관이 이력을 갈라 SHA 대조가 성립하지 않는다(P6 Repo Migration).` +
        ` **보드 표기를 고칠 필요는 없다** — 링크가 이미 레포를 밝히고 있다.`,
    );
  }
  const unknown = by(VERDICT.UNKNOWN_SHA);
  if (unknown.length) {
    console.log(
      `🧭 머지커밋 추적 불가 ${unknown.length}건: ${unknown.map((r) => `#${r.pr}`).join(" ")}` +
        `\n   → 2026-07-21 히스토리 재작성으로 고아가 된 옛 SHA 로 추정된다. **미배포가 아니다** — 재착수 금지.`,
    );
  }
  console.log(`✅ 일치 ${by(VERDICT.OK).length}건`);

  const guessed = results.filter((r) => !r.prConfident);
  if (guessed.length) {
    console.log(
      `\n⚠️ 주 PR 을 본문 링크로 추정한 항목 ${guessed.length}건 — 판정 근거가 약하니 눈으로 확인할 것:` +
        `\n   ${guessed.map((r) => `L${r.lineNumber}→#${r.pr}`).join(" · ")}`,
    );
  }

  if (drift.length) {
    console.log(
      `\n드리프트 ${drift.length}건 — 보드를 고쳐야 한다.` +
        `\n⚠️ 이 도구는 보드를 자동 수정하지 않는다(여러 세션이 동시에 쓰는 git 미추적 파일이라` +
        ` 기계가 남의 줄을 덮어쓰면 복구 수단이 없다). 항목 소유 세션이 상태 줄만 갱신할 것.`,
    );
  } else {
    console.log("\n드리프트 없음.");
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
