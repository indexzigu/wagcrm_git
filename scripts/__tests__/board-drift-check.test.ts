import { describe, it, expect } from "vitest";

import {
  VERDICT,
  DRIFT_VERDICTS,
  boardItemLines,
  classifyItem,
  deployMarkerPath,
  findCoordinatelessItems,
  splitBoardRegions,
  hasDurableReference,
  isClosedItem,
  parseBoardItems,
  parseDeployMarker,
  readClaims,
  statusPhrase,
} from "../board-drift-check.mjs";

// board-drift-check.mjs는 타입 없는 .mjs다 — boardItemLines/splitBoardRegions가 만드는
// 항목 줄의 실제 형태를 여기서 명시해 콜백 매개변수의 implicit any(TS7006)를 없앤다.
type BoardLine = { line: string; lineNumber: number };

/**
 * board-drift-check — 보드 마커 vs gh·git 객관 상태 대조기.
 *
 * 여기서 고정하는 건 "무엇을 드리프트로 셀 것인가"라는 판정 계약이다. 실사고에서 나온
 * 네 가지 함정을 회귀로 박는다:
 *   (A) 머지 ≠ 배포 — 서버 반영 대기를 드리프트로 세면 매 머지마다 거짓 경보가 난다(P6).
 *   (B) git 이 모르는 SHA 를 "미배포"로 보고하면 안 된다 — 2026-07-21 히스토리 재작성으로
 *       그 이전 머지커밋이 고아가 됐고, 미배포로 오인하면 멀쩡한 기능에 재착수가 걸린다.
 *   (C) "배포 완료" 주장이 사실보다 앞서 있는 것(과대보고)은 낡은 대기 마커보다 위험하다(P0).
 *   (D) **배포 축을 모르는 것과 미배포는 다르다** — 2026-08-15 레인 교체에서 추가.
 *
 * ⚠️ **`inProd` 는 3-상태다**(`true`/`false`/`null`). 2026-08-15 이전 필드명은 `inRelease`
 * (= `origin/release` 조상 여부)였는데, 2026-08-13 자체호스팅 컷오버로 그 브랜치가 롤백
 * 창구로만 남아 **전진을 멈췄다**. 판정기만 옛 레인에 남아 컷오버 이후 머지분이 전부
 * 영구히 "승격 대기"로 쌓였다(실측 2026-08-15, 3건 — 전부 이미 프로덕션에 반영됨).
 * 지금 기준은 셀프호스트 배포 마커(`~/selfhost/logs/deployed.sha`)이고, 그 마커를 읽을 수
 * 없는 환경(클라우드 세션·fresh clone)은 `null` = **판정 불가**다.
 */

const merged = (sha = "abc1234") => ({ state: "MERGED", merged: true, sha });

describe("parseBoardItems", () => {
  it("PR 링크가 있는 최상위 불릿만 대조 대상으로 잡는다", () => {
    const board = [
      "# PROJECT_MASTER",
      "",
      "- **🔴 PR 오너 머지 대기 — 무언가 [PR #122](https://github.com/indexzigu/wagcrm_git/pull/122)** · 검증 …",
      "  - 하위 불릿은 항목이 아니다 https://github.com/indexzigu/wagcrm_git/pull/999",
      "- **🧹 PR 링크 없는 서술 항목** — 판정 불가라 건너뛴다",
      "## 오너 액션 큐",
    ].join("\n");

    const items = parseBoardItems(board);
    expect(items).toHaveLength(1);
    expect(items[0].pr).toBe(122);
    expect(items[0].lineNumber).toBe(3);
  });

  it("본문이 다른 PR 을 근거로 인용해도 판정 대상은 헤더의 PR 이다", () => {
    const board =
      "- **🔴 PR 오너 머지 대기 — X [PR #90](https://github.com/indexzigu/wagcrm_git/pull/90)**: 근거는 [#75](https://github.com/indexzigu/wagcrm_git/pull/75) 참조";
    expect(parseBoardItems(board)[0].pr).toBe(90);
  });

  it("헤더 안 중첩 볼드가 있어도 항목을 스킵하지 않는다", () => {
    // 보드 헤더는 강조용 중첩 볼드를 흔히 쓴다. 첫 닫는 `**` 를 헤더 끝으로 보면 링크를
    // 못 찾아 항목이 통째로 조용히 사라진다 — 실보드 35건 중 8건이 그렇게 누락됐다.
    const board =
      "- **🔴 PR 오너 머지 대기 — 알림센터 **전면 해체** → 카드 대체 [PR #101](https://github.com/indexzigu/wagcrm_git/pull/101)**: 본문…";
    const items = parseBoardItems(board);
    expect(items).toHaveLength(1);
    expect(items[0].pr).toBe(101);
    expect(items[0].prConfident).toBe(true);
  });

  it("헤더에 링크가 없으면 본문에서 추정하되 낮은 신뢰로 표시한다(스킵 금지)", () => {
    const board =
      "- **✅ 트랙 종결·착지 완료 — 코드 정리**: **[PR #52](https://github.com/indexzigu/wagcrm_git/pull/52)** 본문…";
    const items = parseBoardItems(board);
    expect(items).toHaveLength(1);
    expect(items[0].pr).toBe(52);
    expect(items[0].prConfident).toBe(false);
  });

  it("상태 문구가 다른 PR 을 참조해도 주 PR 은 제목에 붙은 마지막 링크다", () => {
    // 실제 보드(#120 항목): 상태 문구가 후속 PR #124 를 언급한다. '첫 링크' 규칙이면
    // #124 를 주 PR 로 잡아 M1 서술을 통째로 덮어쓴다(정정 패스 예행에서 실제로 잡혔다).
    const board =
      "- **🟢 M1 머지 완료(`fefa1ea`) / 후속 [PR #124](https://github.com/indexzigu/wagcrm_git/pull/124) 오너 머지 대기 — 클레임 레지스트리 M1 [PR #120](https://github.com/indexzigu/wagcrm_git/pull/120)**: 본문…";
    expect(parseBoardItems(board)[0].pr).toBe(120);
  });
});

describe("readClaims", () => {
  it("대기 주장과 배포 완료 주장을 문구로 읽는다", () => {
    expect(readClaims("- **🔴 PR 오너 머지 대기 — X**").awaitingMerge).toBe(true);
    expect(readClaims("- **🟢 머지·prod 배포 완료 — X**").deployed).toBe(true);
    expect(readClaims("- **🚀 머지 완료 / 잔여=승격 배포 확인 — X**").awaitingDeploy).toBe(true);
  });

  it("'배포 확인'이 잔여 문맥이 아니면 대기로 읽지 않는다", () => {
    // 완료 서술 안의 '배포 확인 완료'를 잔여로 오독하면 끝난 항목이 영원히 드리프트로 뜬다.
    const line = "- **✅ 머지·prod 배포 확인 완료 · 오너 육안만 — X**";
    expect(readClaims(line).awaitingDeploy).toBe(false);
    expect(readClaims(line).deployed).toBe(true);
  });

  it("'배포 확인 완료' + 다른 잔여 게이트가 같은 줄에 있어도 대기로 읽지 않는다", () => {
    // 실제 보드 유형: 배포는 끝났고 잔여는 전혀 다른 것(실측·육안). 첫 구현이 여기서 오탐했다.
    const line = "- **🟢 머지(`33ffdd6`)·prod 배포 확인 완료 / 잔여=24~48h 후 egress 기울기 실측 — X**";
    expect(readClaims(line).awaitingDeploy).toBe(false);
    expect(readClaims(line).deployed).toBe(true);
  });

  it("완료 근거로 적힌 '배포 확인(sha)'는 잔여 게이트가 따로 있어도 대기가 아니다", () => {
    // 실제 보드 유형(#88): 본문은 배포 확인 근거를 sha 로 남기고, 잔여는 오너 육안뿐.
    // '줄에 잔여가 있으면 대기'로 읽던 첫 구현이 여기서 오탐했다 → 게이트 서술 안에서만 센다.
    const line =
      "- **🟢 전 과정 완료 / 잔여=오너 육안 1건 — 키 교체 [PR #88](…/pull/88)**: 머지·prod 배포 확인(`e5fa5de`) · 재암호화 실행 완료";
    expect(readClaims(line).awaitingDeploy).toBe(false);
  });

  it("데모 레인 첫 배포 대기를 prod 미배포로 읽지 않는다", () => {
    // 운영 release 와 데모 demo 는 다른 레인이다(P6) — 데모 대기를 prod 드리프트로 세면 오탐.
    const line = "- **🟢 머지·설정 완료(잔여=데모 첫 배포 확인) — 운영·데모 배포 레인 분리 [PR #74](…/pull/74)**";
    expect(readClaims(line).awaitingDeploy).toBe(false);
  });
});

describe("readClaims — 주장은 상태 문구에만 있다", () => {
  it("본문·게이트 서술에 나오는 '머지 대기'를 주장으로 읽지 않는다", () => {
    // 실사고: 워처를 설명하는 문구("세션이 머지대기→await-promotion.sh…") 때문에
    // 이미 머지된 자기 항목이 '낡은 대기 마커'로 잡혔다. 점검기가 거짓 경보를 내면
    // 사람이 점검기를 무시하게 되므로, 낡은 마커를 놓치는 것만큼 해롭다.
    const line =
      "- **🚀 머지 완료(`57bf6e3`) / 잔여=승격 배포 확인 — 보드 마커 드리프트 점검기 [PR #126](https://github.com/indexzigu/wagcrm_git/pull/126)** · 다음 게이트: ①오너 머지 ②승격 배포 확인(세션이 머지대기→`await-promotion.sh` 워처 가동 중)";
    expect(readClaims(line).awaitingMerge).toBe(false);
    expect(readClaims(line).awaitingDeploy).toBe(true);
  });

  it("상태 문구의 '머지 대기'는 그대로 주장으로 읽는다", () => {
    const line = "- **🔴 PR 오너 머지 대기 — X [PR #1](https://github.com/indexzigu/wagcrm_git/pull/1)** · 본문";
    expect(readClaims(line).awaitingMerge).toBe(true);
  });

  /**
   * 어순 비의존 판정 (2026-08-05 추가 — 이 도구의 위음성 수정).
   *
   * 🪤 `/머지\s*대기/` 하나로 읽던 시절, 실보드의 `⏳ CI 대기 → 오너 머지` 는 "대기"가
   * "머지" 앞이라 매치하지 않아 **STALE_MERGE_MARKER 가 발화 자체를 못 했다**. 그 상태로
   * 머지·prod 반영까지 끝난 PR 2건이 대기 문구로 남아 있었는데 점검기는 "드리프트 없음"을
   * 보고했고, 사람이 손으로 정정한 뒤에도 **출력이 완전히 동일**했다(양방향 실명).
   * 아래 음성 대조군 2건이 없으면 이 수정은 오탐으로 뒤집힌다 — 함께 고정한다.
   */
  it("'대기'가 '머지' 앞에 와도 대기 주장으로 읽는다(2026-08-05 위음성)", () => {
    const line =
      "- **⏳ CI 대기 → 오너 머지 — 무언가 [PR #275](https://github.com/indexzigu/wagcrm_git/pull/275)** · 본문";
    expect(readClaims(line).awaitingMerge).toBe(true);
  });

  it("⚠️ 완료 서술은 대기 주장이 아니다 — `머지 완료 → 승격 대기`", () => {
    // 실보드에서 가장 흔한 형태다. 여기서 오탐하면 머지될 때마다 거짓 경보가 난다.
    expect(readClaims("- **🚀 머지 완료 → 승격(배포) 대기 — X**").awaitingMerge).toBe(false);
  });

  it("⚠️ 완료 서술은 대기 주장이 아니다 — `머지·승격·prod 배포 완료`", () => {
    expect(readClaims("- **✅ 머지·승격·prod 배포 완료 — X**").awaitingMerge).toBe(false);
  });

  it("상태 문구에 '머지'가 없으면 대기 신호만으로 대기 주장이 되지 않는다", () => {
    expect(readClaims("- **🔵 오너 결정 대기 2건 — X**").awaitingMerge).toBe(false);
    expect(readClaims("- **🔴 진행 중 — X**").awaitingMerge).toBe(false);
  });

  it("상태 문구는 헤더의 첫 ' — ' 앞까지다", () => {
    expect(statusPhrase("- **🔴 PR 오너 머지 대기 — 제목 [PR #1](…/pull/1)**: 본문")).toBe("🔴 PR 오너 머지 대기");
  });
});

describe("classifyItem — 머지 ≠ 배포 (A)", () => {
  it("머지됐지만 아직 프로덕션 서버에 없으면 배포 대기이지 드리프트가 아니다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: true, deployed: false },
      { ...merged(), shaKnown: true, inMain: true, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.AWAITING_DEPLOY);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("머지 끝난 항목에 '머지 대기' 마커가 남아 있으면 배포 전이라도 낡은 마커다", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      { ...merged(), shaKnown: true, inMain: true, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.STALE_MERGE_MARKER);
  });
});

describe("classifyItem — 고아 SHA 를 미배포라 하지 않는다 (B)", () => {
  it("git 이 머지커밋을 모르면 UNKNOWN_SHA 이고 드리프트로 세지 않는다", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      { ...merged("deadbee"), shaKnown: false, inMain: false, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.UNKNOWN_SHA);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
    expect(r.detail).toContain("미배포가 아니다");
  });

  it("객체는 살아 있어도 main 이력에 없으면 고아다 — 존재 검사만으로 판정하지 않는다", () => {
    // 히스토리 재작성 후 옛 머지커밋은 reflog·GC 유예로 `cat-file` 을 통과한다.
    // 첫 구현이 이걸 근거로 #45·#52·#54 를 '과대보고'로 잘못 잡았다.
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      { ...merged("c503867"), shaKnown: true, inMain: false, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.UNKNOWN_SHA);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("추적 불가를 과대보고(OVERCLAIMED)로 승격시키지 않는다 — 모르는 건 모르는 것이다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      { ...merged("deadbee"), shaKnown: false, inMain: false, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.UNKNOWN_SHA);
  });
});

describe("classifyItem — 과대보고 (C)", () => {
  it("'배포 완료'라는데 배포 마커의 조상이 아니면 과대보고로 잡는다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      { ...merged(), shaKnown: true, inMain: true, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.OVERCLAIMED_DEPLOY);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(true);
  });
});

/**
 * 배포 축 판정 불가 (D) — 2026-08-15 레인 교체에서 신설.
 *
 * 판정 기준이 `origin/release`(모든 체크아웃이 fetch 로 볼 수 있는 ref)에서 셀프호스트
 * 배포 마커(**그 기계에만 있는 파일**)로 옮겨가면서 새로 생긴 상태다. 클라우드 세션·
 * fresh clone 에는 `~/selfhost/` 가 아예 없다.
 *
 * ⚠️ 이 상태를 `false`(미배포)로 접으면 그 환경에서 **보드 전체가 미배포로 뒤집힌다** —
 * 설계 원칙 2("모르는 것을 미배포라고 하지 않는다")의 정면 위반이고, 고아 SHA 를
 * UNKNOWN_SHA 로 분리한 것과 같은 이유다. 반대로 `true` 로 접으면 과대보고를 놓친다.
 * 그래서 3-상태이고, 아래가 그 분리를 고정한다.
 */
describe("classifyItem — 배포 판정 불가는 미배포가 아니다 (D)", () => {
  const unknownProd = { ...merged(), shaKnown: true, inMain: true, inProd: null };

  it("마커를 못 읽으면 DEPLOY_UNVERIFIABLE 이고 드리프트로 세지 않는다", () => {
    const r = classifyItem({ awaitingMerge: false, awaitingDeploy: true, deployed: false }, unknownProd);
    expect(r.verdict).toBe(VERDICT.DEPLOY_UNVERIFIABLE);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
    expect(r.detail).toContain("미배포가 아니다");
  });

  it("⚠️ 판정 불가를 과대보고로 승격시키지 않는다 — 반증할 근거가 없다", () => {
    // 여기서 OVERCLAIMED 를 내면 마커 없는 환경에서 '배포 완료' 마커가 전부 거짓 경보가 된다.
    const r = classifyItem({ awaitingMerge: false, awaitingDeploy: false, deployed: true }, unknownProd);
    expect(r.verdict).toBe(VERDICT.DEPLOY_UNVERIFIABLE);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("배포 축을 몰라도 **머지 축**은 판정한다 — 낡은 머지 대기 마커는 그대로 잡는다", () => {
    // 탐지력을 통째로 끄지 않는다: 머지 여부는 gh + main 조상으로 판정되고 마커와 무관하다.
    const r = classifyItem({ awaitingMerge: true, awaitingDeploy: false, deployed: false }, unknownProd);
    expect(r.verdict).toBe(VERDICT.STALE_MERGE_MARKER);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(true);
  });

  it("⚠️ `inProd` 누락(undefined)도 판정 불가로 접는다 — truthy 검사 회귀 방지", () => {
    // `if (fact.inProd)` 로 되돌리면 이 케이스가 조용히 '미배포' 분기로 흘러든다.
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      { ...merged(), shaKnown: true, inMain: true },
    );
    expect(r.verdict).toBe(VERDICT.DEPLOY_UNVERIFIABLE);
  });

  it("판정 불가보다 고아 SHA 가 먼저다 — 머지커밋 자체를 모르면 UNKNOWN_SHA", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      { ...merged("deadbee"), shaKnown: false, inMain: false, inProd: null },
    );
    expect(r.verdict).toBe(VERDICT.UNKNOWN_SHA);
  });
});

/**
 * 배포 마커 판독 — 형태가 아니면 `null`(판정 불가)이지 "배포된 것이 없다"가 아니다.
 * 빈 파일·쓰다 만 파일을 미배포로 읽으면 보드 전체가 한 번에 뒤집힌다.
 */
describe("parseDeployMarker", () => {
  it("SHA 를 읽고 개행·공백을 걷어낸다(deploy.sh 는 printf '%s\\n' 로 쓴다)", () => {
    expect(parseDeployMarker("651bfafa12130183f8a845c13849d3ac5b23e856\n")).toBe(
      "651bfafa12130183f8a845c13849d3ac5b23e856",
    );
    expect(parseDeployMarker("  abc1234  ")).toBe("abc1234");
  });

  it("⚠️ 빈 파일·비-SHA 내용·부재는 전부 null 이다 — 미배포로 단정하지 않는다", () => {
    expect(parseDeployMarker("")).toBeNull();
    expect(parseDeployMarker("\n")).toBeNull();
    expect(parseDeployMarker("(마커 없음)")).toBeNull();
    expect(parseDeployMarker("zzzz999")).toBeNull(); // 16진수가 아니다
    expect(parseDeployMarker("abc12")).toBeNull(); // 너무 짧다(우연한 일치 방지)
    expect(parseDeployMarker(undefined)).toBeNull();
  });
});

describe("deployMarkerPath", () => {
  it("기본값은 deploy.sh 의 프로덕션 레인 마커다(체크아웃 밖, ~/selfhost/logs)", () => {
    const prev = process.env.BOARD_CHECK_DEPLOY_MARKER;
    delete process.env.BOARD_CHECK_DEPLOY_MARKER;
    try {
      // ⛔ 프리뷰 레인 마커(`deployed.<라벨끝>.sha`)를 집으면 안 된다 — 프리뷰도 main 을
      // 추종하므로 SHA 가 그럴듯해 보이지만 프로덕션이 서빙하는 커밋이 아니다(P6).
      expect(deployMarkerPath().endsWith("/selfhost/logs/deployed.sha")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.BOARD_CHECK_DEPLOY_MARKER = prev;
    }
  });

  it("env 로 갈아끼울 수 있다 — 실 마커를 건드리지 않고 프로브를 돌리는 통로", () => {
    const prev = process.env.BOARD_CHECK_DEPLOY_MARKER;
    process.env.BOARD_CHECK_DEPLOY_MARKER = "/tmp/probe-deployed.sha";
    try {
      expect(deployMarkerPath()).toBe("/tmp/probe-deployed.sha");
    } finally {
      if (prev === undefined) delete process.env.BOARD_CHECK_DEPLOY_MARKER;
      else process.env.BOARD_CHECK_DEPLOY_MARKER = prev;
    }
  });
});

describe("classifyItem — 일치·미머지", () => {
  it("머지·배포 완료 + 완료 마커면 OK", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      { ...merged(), shaKnown: true, inMain: true, inProd: true },
    );
    expect(r.verdict).toBe(VERDICT.OK);
  });

  it("배포까지 끝났는데 대기 마커가 남아 있으면 낡은 마커다(2026-07-29 실사고 유형)", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      { ...merged(), shaKnown: true, inMain: true, inProd: true },
    );
    expect(r.verdict).toBe(VERDICT.STALE_MERGE_MARKER);
  });

  it("미머지 + 대기 마커는 정확하므로 OK", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      { state: "OPEN", merged: false, sha: null, shaKnown: false, inMain: false, inProd: false },
    );
    expect(r.verdict).toBe(VERDICT.OK);
  });

  it("조회 불가 PR 은 드리프트로 표면화한다(번호 오기·구 레포 번호 혼동)", () => {
    const r = classifyItem({ awaitingMerge: true, awaitingDeploy: false, deployed: false }, undefined);
    expect(r.verdict).toBe(VERDICT.PR_NOT_FOUND);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(true);
  });
});

/**
 * 보드 줄 → 판정 왕복 (2026-08-05 추가).
 *
 * readClaims 단위 테스트만으로는 이번 위음성이 안 잡혔다 — 문구 판정과 최종 verdict 사이가
 * 끊겨 있으면 "claims 는 맞는데 보고는 안 된다"가 가능하다. 실보드 문구를 그대로 넣어
 * **verdict 까지** 고정한다.
 */
describe("보드 문구 → verdict 왕복", () => {
  const verdictOf = (line: string, fact: Record<string, unknown>) =>
    classifyItem(readClaims(line), fact).verdict;
  const shipped = { ...merged(), shaKnown: true, inMain: true, inProd: true };
  const deployPending = { ...merged(), shaKnown: true, inMain: true, inProd: false };

  it("`⏳ CI 대기 → 오너 머지` + 머지·배포 완료 → 낡은 마커", () => {
    expect(verdictOf("- **⏳ CI 대기 → 오너 머지 — X**", shipped)).toBe(VERDICT.STALE_MERGE_MARKER);
  });

  it("`🔴 PR 오너 머지 대기` + 머지·배포 완료 → 낡은 마커(기존 어순 회귀 방지)", () => {
    expect(verdictOf("- **🔴 PR 오너 머지 대기 — X**", shipped)).toBe(VERDICT.STALE_MERGE_MARKER);
  });

  it("⚠️ `✅ 머지·승격·prod 배포 완료` + 머지·배포 완료 → OK(음성 대조군)", () => {
    expect(verdictOf("- **✅ 머지·승격·prod 배포 완료 — X**", shipped)).toBe(VERDICT.OK);
  });

  it("⚠️ `🚀 머지 완료 → 승격 대기` + release 미반영 → 승격 대기(정상, 드리프트 아님)", () => {
    const r = classifyItem(readClaims("- **🚀 머지 완료 → 승격(배포) 대기 — X**"), deployPending);
    expect(r.verdict).toBe(VERDICT.AWAITING_DEPLOY);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
  });

  /**
   * 🪤 회귀 (2026-08-05, PR #288 직후 실측). 완료 문구 제외가 **`머지 완료` 형태만** 덮어서,
   * `완료` 없이 `머지 → 승격 대기` 로 쓴 줄이 "아직 머지 대기"로 읽혔다. 실보드에서 종료코드
   * 3 이 상시로 떴고 잡힌 대상이 하필 그 수정 자신의 보드 줄이었다 — 설계 원칙 3 정면 위반.
   */
  it("⚠️ `🚀 머지 → 승격 대기`(완료 낱말 없음) + release 미반영 → 승격 대기", () => {
    const r = classifyItem(readClaims("- **🚀 머지 → 승격 대기 — X**"), deployPending);
    expect(r.verdict).toBe(VERDICT.AWAITING_DEPLOY);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("`머지 후 배포 확인` 형태도 머지 대기가 아니다", () => {
    expect(readClaims("- **🚀 머지 후 승격 배포 확인 대기 — X**").awaitingMerge).toBe(false);
  });

  /**
   * 배포 주장도 상태 문구가 우선이다 (같은 계열의 마지막 잔여분).
   *
   * 🪤 `deployed` 만 줄 전체를 읽고 있어서, 본문의 경과 서술(`prod 반영`)이 배포 주장으로
   * 읽혀 **상태 문구가 `승격 대기` 라고 명시하는 항목**이 과대보고로 잡혔다. 보드는 옳고
   * 판정기가 틀린 상태로 종료코드 3 이 상시 발화했다(실측 2026-08-05).
   *
   * 다만 본문을 통째로 버리진 않는다 — 과대보고는 낡은 마커보다 위험하다(설계 원칙 3).
   * 상태 문구가 배포에 **침묵할 때만** 본문을 본다. 아래 마지막 케이스가 그 탐지력을 고정한다.
   */
  it("⚠️ 상태 문구가 `승격 대기` 면 본문의 `prod 반영` 서술은 배포 주장이 아니다", () => {
    const line =
      "- **🚀 머지 완료 → 승격(배포) 대기 — X [PR #288](…/pull/288)**: 머지·prod 반영이 끝난 PR 2건이 그 문구로 남아 있었다(결함 설명)";
    expect(readClaims(line).deployed).toBe(false);
    expect(classifyItem(readClaims(line), deployPending).verdict).toBe(VERDICT.AWAITING_DEPLOY);
  });

  it("상태 문구가 배포를 주장하면 그대로 주장이다", () => {
    expect(readClaims("- **✅ 머지·prod 배포 완료 — X**").deployed).toBe(true);
  });

  it("⚠️ 상태 문구가 배포에 침묵하면 본문까지 본다 — 과대보고 탐지력 보존", () => {
    // 이 단언이 깨지면 오탐을 고치다 **미탐**을 만든 것이다(설계 원칙 3 — 훨씬 나쁘다).
    const line = "- **🔵 조사 완료 — X [PR #9](…/pull/9)**: 본문… prod 배포 완료(`abc1234`)";
    expect(readClaims(line).deployed).toBe(true);
    expect(classifyItem(readClaims(line), deployPending).verdict).toBe(VERDICT.OVERCLAIMED_DEPLOY);
  });
});

/**
 * 어휘 확장 — "오너 리뷰 대기" / "승격 대기" (2026-08-08 아침 브리핑 세션 실사고).
 *
 * 🪤 `npm run board:check` 가 종료코드 0(드리프트 없음)을 보고했는데, 같은 시각 `gh pr
 * list` 대조로는 보드 항목 6건(#336·#335·#328·#313·#303·#297)이 **전부 머지+prod 배포까지
 * 끝났는데도** 대기 문구로 남아 있었다. 원인은 어휘 폭이 좁아서였다:
 *  - "PR 생성 · 오너 리뷰 대기" — "머지"라는 글자가 아예 없어 claimsAwaitingMerge 의
 *    `/머지/` 필수 검사를 통과 못 했다.
 *  - "머지 완료 · 승격(배포) 대기" / "머지 완료 · 승격 대기" — "배포"·"대기"가 있어도
 *    기존 pendingDeploy 는 `잔여`/`다음 게이트` 라벨이 붙은 세그먼트 안에서만 찾아서,
 *    상태 문구 자체에 실린 이 표현을 놓쳤다.
 * 판정 단계 이전에 "대기 주장 없음"으로 오분류돼 STALE_MERGE_MARKER 가 발화 자체를
 * 못 했다 — 이 도구가 막으려는 바로 그 사고(2026-07-29)의 재발이다.
 */
describe("readClaims — 오너 리뷰 대기 / 승격 대기 (2026-08-08 실사고)", () => {
  it("'오너 리뷰 대기'는 '머지'라는 글자가 없어도 머지 대기 주장으로 읽는다", () => {
    expect(readClaims("- **PR 생성 · 오너 리뷰 대기 — X**").awaitingMerge).toBe(true);
  });

  it("'승격(배포) 대기'는 상태 문구 자체에 있어도 배포 대기 주장으로 읽는다", () => {
    const claims = readClaims("- **머지 완료 · 승격(배포) 대기 — X**");
    expect(claims.awaitingDeploy).toBe(true);
    expect(claims.awaitingMerge).toBe(false); // 머지 자체는 완료 — 낡은 어휘로 재판정하면 안 된다
  });

  it("'승격 대기'(괄호 없음)도 배포 대기 주장으로 읽는다", () => {
    expect(readClaims("- **머지 완료 · 승격 대기 — X**").awaitingDeploy).toBe(true);
  });

  it("⚠️ '승격 완료'는 '대기'가 없으므로 배포 대기 주장이 아니다(과대 매치 방지)", () => {
    expect(readClaims("- **✅ 머지·승격 완료 — X**").awaitingDeploy).toBe(false);
  });

  it("⚠️ '오너 리뷰 완료'는 '대기'가 없으므로 머지 대기 주장이 아니다(과대 매치 방지)", () => {
    expect(readClaims("- **오너 리뷰 완료 — X**").awaitingMerge).toBe(false);
  });
});

describe("보드 문구 → verdict 왕복 — 2026-08-08 실사고 6건 재현", () => {
  const verdictOf = (line: string, fact: Record<string, unknown>) =>
    classifyItem(readClaims(line), fact).verdict;
  const shipped = { ...merged(), shaKnown: true, inMain: true, inProd: true };

  it("`PR 생성 · 오너 리뷰 대기` + 머지·배포 완료 → 낡은 마커(#336·#328·#313 유형)", () => {
    expect(verdictOf("- **PR 생성 · 오너 리뷰 대기 — X**", shipped)).toBe(VERDICT.STALE_MERGE_MARKER);
  });

  it("`머지 완료 · 승격(배포) 대기` + 머지·배포 완료 → 낡은 마커(#335 유형)", () => {
    expect(verdictOf("- **머지 완료 · 승격(배포) 대기 — X**", shipped)).toBe(VERDICT.STALE_MERGE_MARKER);
  });

  it("`머지 완료 · 승격 대기` + 머지·배포 완료 → 낡은 마커(#303·#297 유형)", () => {
    expect(verdictOf("- **머지 완료 · 승격 대기 — X**", shipped)).toBe(VERDICT.STALE_MERGE_MARKER);
  });
});

/**
 * 좌표 없는 항목 판정 (2026-07-30 추가).
 *
 * ⚠️ **실사고에서 나왔다.** 한 세션이 보드를 배열 인덱스로 치환해(`lines[1] = 새줄`)
 * 타 세션 줄을 덮어썼다. 보드는 git 미추적이라 되돌릴 이력이 없다. 피해 범위를
 * 조사했더니 **PR 링크가 있는 항목은 전부 대조로 확인**됐지만(gh·`PROJECT_LOG`),
 * PR 도 상세 파일도 없는 항목은 **사라졌는지조차 확인할 수 없었다** — 대조할 좌표가
 * 아예 없기 때문이다.
 *
 * 그래서 `parseBoardItems` 가 의도적으로 건너뛰던 사각(PR 없는 항목)을 별도로 센다.
 * 이 판정은 **드리프트가 아니다**(종료코드 불변) — 도입 시점에 수십 건이 걸려 즉시
 * 실패로 뜨면 이 도구의 기존 원칙(거짓 경보가 낡은 마커보다 해롭다)을 어긴다.
 */
describe("boardItemLines — PR 유무와 무관하게 항목 줄 전부", () => {
  it("최상위 불릿만 잡고 1-기반 줄번호를 붙인다", () => {
    const board = [
      "# PROJECT_MASTER",
      "- **항목 A** 내용",
      "  - 하위 불릿은 항목이 아니다",
      "- **항목 B** 내용",
      "## 섹션 헤더는 항목이 아니다",
    ].join("\n");
    const lines = boardItemLines(board);
    expect(lines.map((l: BoardLine) => l.lineNumber)).toEqual([2, 4]);
  });

  it("parseBoardItems 의 줄번호와 어긋나지 않는다", () => {
    // 같은 스캐너를 공유하므로 두 함수의 줄번호가 갈리면 보고서가 엉뚱한 줄을 가리킨다.
    const board = [
      "# PROJECT_MASTER",
      "- **PR 없는 항목** 내용",
      "- **🔴 머지 대기 — 무언가 [PR #10](https://github.com/indexzigu/wagcrm_git/pull/10)**: …",
    ].join("\n");
    expect(parseBoardItems(board)[0].lineNumber).toBe(3);
    expect(boardItemLines(board).map((l: BoardLine) => l.lineNumber)).toEqual([2, 3]);
  });

  /**
   * 아래 4건은 2026-09-04 실측에서 나왔다. 보드에 새로 올라오는 항목이 하네스 세션명
   * 규약(`상태프리픽스 #번호 [계보슬러그] 제목`)을 쓰면서 **볼드 없이** 시작하게 됐고,
   * `- **` 만 보던 종전 스캐너가 그 줄들을 항목으로 보지 않았다 — 낡아도 조용한
   * 침묵 실패다. 반대로 `- ` 전부로 넓히면 `###` 이하 인계 서사의 부연 줄 135개가
   * 딸려 들어온다. 그래서 **구역**으로 가른다.
   */
  it("평면 구역에서는 볼드 없는 새 형식(이모지 프리픽스) 도 항목이다", () => {
    const board = [
      "# PROJECT_MASTER",
      "- ✅ #7 #8 [슬러그] 무언가 — 머지·배포 완료",
      "- 🚀 #9 [슬러그] 다른 것 — 남은 게이트 = 오너 재설치",
    ].join("\n");
    expect(boardItemLines(board).map((l: BoardLine) => l.lineNumber)).toEqual([2, 3]);
  });

  it("평면 구역의 옛 산문형(`- 착수 대기: …`) 도 항목이다", () => {
    const board = ["# PROJECT_MASTER", "- 착수 대기: 무언가 — 다음 게이트: 오너 확인"].join(
      "\n",
    );
    expect(boardItemLines(board).map((l: BoardLine) => l.lineNumber)).toEqual([2]);
  });

  it("`###` 이하 인계 서사의 볼드 없는 부연 줄은 항목이 아니다", () => {
    // 이 가드가 없으면 실보드에서 부연 135줄이 항목으로 잡혀 대량 오탐이 난다.
    // 부연은 항목과 **형태가 같아서**(`- ✅ **…**`) 생김새로는 가를 수 없다 — 구역이 기준이다.
    const board = [
      "# PROJECT_MASTER",
      "- **평면 항목** 내용",
      "### 2026-09-04 · 세션 [슬러그] — 무언가",
      "- 검증: typecheck·lint 클린",
      "- 다음 에이전트: 남은 것 없음",
      "- ✅ 실렌더 확인 완료",
    ].join("\n");
    expect(boardItemLines(board).map((l: BoardLine) => l.lineNumber)).toEqual([2]);
  });

  it("`###` 이하의 `- **` 줄은 종전대로 항목으로 유지한다", () => {
    // 넓히는 변경이 커버리지를 **줄이지는** 않게 고정한다 — 줄이는 방향의 오류가 곧 침묵이다.
    const board = [
      "# PROJECT_MASTER",
      "### 2026-09-04 · 세션 [슬러그] — 무언가",
      "- **✅ 머지 완료 — 무언가 [PR #10](https://github.com/indexzigu/wagcrm_git/pull/10)**: …",
    ].join("\n");
    expect(boardItemLines(board).map((l: BoardLine) => l.lineNumber)).toEqual([3]);
  });
});

describe("hasDurableReference — 보드 밖 두 번째 사본이 있는가", () => {
  it("활성 핸드오프 링크를 인정한다", () => {
    expect(hasDurableReference("- **항목** · [상세](docs/handoff/some-item.md)")).toBe(true);
  });

  it("아카이브된 핸드오프도 인정한다 — 착지 후 경로가 바뀔 뿐 사본은 남는다", () => {
    expect(
      hasDurableReference("- **항목** · [상세](docs/archive/handoff/pr-151-x.md)"),
    ).toBe(true);
  });

  it("PROJECT_LOG 참조도 인정한다 — 파일이 달라 이미 이중화다", () => {
    // 실보드에 "상세는 `PROJECT_LOG` 2026-07-23 두 줄" 형태가 있다. 이걸 좌표 없음으로
    // 잡으면 오탐이고, 오탐은 사람이 이 경고를 무시하게 만든다.
    expect(hasDurableReference("- **함정 모음** 상세는 `PROJECT_LOG` 2026-07-23 두 줄")).toBe(
      true,
    );
  });

  it("아무 참조도 없으면 false", () => {
    expect(hasDurableReference("- **🖥️ prod 육안 큐 (9건)**: 화면 3개 확인할 것")).toBe(false);
  });
});

describe("isClosedItem — 닫힌 항목은 좌표 위험이 아니다", () => {
  it("상태 문구의 종결 마커를 읽는다", () => {
    expect(isClosedItem("- **✅ 종결 — 무언가 했다**: 상세…")).toBe(true);
    expect(isClosedItem("- **⛔ SUPERSEDED — 대체됨**: 상세…")).toBe(true);
  });

  it("잔여·다음 게이트가 있으면 아직 살아 있다", () => {
    // 이 보드의 관례상 완료 서술과 잔여가 한 줄에 같이 온다 — 완료 낱말만 보고
    // 닫혔다고 판정하면 살아 있는 항목이 경고에서 빠진다.
    expect(isClosedItem("- **✅ 머지 완료 / 잔여=승격 — 무언가**: 상세…")).toBe(false);
    expect(isClosedItem("- **✅ 완료 / 다음 게이트=오너 육안 — 무언가**: 상세…")).toBe(false);
  });

  /**
   * 게이트는 본문에 적힌다 (2026-08-05 추가 — 위양성 3건·위음성 1건 수정).
   *
   * ⚠️ **수명주기 스윕 중 실측으로 나왔다.** 평면 구역에 이 판정을 돌려 종결 후보 6건을
   * 얻었는데 **3건이 위양성**이었다 — 이 보드는 게이트를 상태 문구가 아니라 **본문에**
   * 적고(`✅ 배포 완료 … 다음 게이트 = **오너 실작업**`), 괄호 안 하위 절의 `⛔` 를
   * 항목 전체의 종결로 읽었다. 그대로 스윕했다면 **활성 항목 3건이 딸려 나간다**
   * (2026-07-31 실사고와 같은 형태 — 보드는 git 미추적이라 되돌릴 이력이 없다).
   *
   * 오탐 방향이 비대칭이다: "살아 있는데 닫혔다"는 남의 줄을 지우고, "닫혔는데 살았다"는
   * 줄이 조금 더 남을 뿐이다. 아래 4건은 그 비대칭을 고정한다.
   */
  it("⚠️ 상태 문구가 완료여도 본문에 게이트가 있으면 살아 있다", () => {
    const line =
      "- **✅ 머지·승격·prod 배포 완료 — 원천징수 실명 필드 [PR #258](…/pull/258)**: 다음 게이트 = **오너 실작업: 실명 입력**(신설 필드라 전원 비어 있다)";
    expect(isClosedItem(line)).toBe(false);
  });

  it("⚠️ 괄호 안 하위 절의 ⛔ 는 항목 전체의 종결이 아니다 — 배칭 큐", () => {
    const line = '- **📦 배칭 대기 큐 (⛔ 종전 "단독 PR 금지" 는 전제 소멸 — 2026-08-01 정정)**: 내용…';
    expect(isClosedItem(line)).toBe(false);
  });

  it("⚠️ 괄호 안 ⛔SUPERSEDED 도 마찬가지다 — 괄호가 안 닫힌 채 잘려도", () => {
    // statusPhrase 는 첫 ` — ` 에서 자르므로 괄호가 열린 채 끝날 수 있다. 그래도 걷어내야 한다.
    const line = "- **🟡 트래픽 위생 존치(다운 임박은 ⛔SUPERSEDED — 실측 후 철회) — X**: 잔여 4분";
    expect(isClosedItem(line)).toBe(false);
  });

  it("'다음 게이트 없음'을 게이트로 읽지 않는다(위음성 회귀)", () => {
    // 낱말만 찾던 종전 판정은 부정어를 못 봐서 진짜 종결 항목을 영영 안 닫힌 것으로 봤다.
    expect(isClosedItem("- **✅ 종결(코드 변경 0 · 다음 게이트 없음) — X**: 내용…")).toBe(true);
    expect(
      isClosedItem("- **✅ 머지·승격·prod 배포 완료 — X**: 상세… 다음 게이트 = **없음(종결)**"),
    ).toBe(true);
  });

  it("⚠️ 상태 문구의 '게이트 없음'은 본문의 낡은 게이트 서술보다 우선한다", () => {
    // 이 우선순위가 없으면 실보드에서 **종결 후보가 0건이 된다(실측)**. 완료 항목의 본문은
    // 착지까지의 경과를 그대로 안고 있어 과거 게이트 선언이 서술로 남는다 — 그걸 살아 있는
    // 게이트로 읽으면 아무것도 닫히지 않고 판정기가 조용히 무용지물이 된다.
    const line =
      "- **✅ 머지·prod 배포 완료·종결(다음 게이트 없음) — X [PR #220](…/pull/220)**: 착지 경과… 다음 게이트 = **PR 생성 → CI 3종 → 오너 머지**(당시 서술)";
    expect(isClosedItem(line)).toBe(true);
  });

  it("상태 문구가 게이트를 선언하면 그것이 최신 주장이다 — 본문을 보지 않는다", () => {
    const line = "- **✅ 완료(다음 게이트 = prod 육안 2건) — X**: 본문에는 게이트 언급 없음";
    expect(isClosedItem(line)).toBe(false);
  });

  it("⛔ SUPERSEDED 항목은 그대로 종결이다(음성 대조군)", () => {
    // 괄호 절을 걷는 수정이 기존 동작을 깨지 않았는지 고정한다.
    expect(isClosedItem("- **⛔ SUPERSEDED → 위 종결 줄(2026-07-31, 세션 xxx 가 완료)**: 내용…")).toBe(
      true,
    );
  });

  it("본문의 종결 낱말은 상태 주장이 아니다", () => {
    // statusPhrase 규약과 같은 이유 — 본문 서술을 주장으로 읽으면 오판한다.
    expect(isClosedItem("- **🔴 오너 결정 대기 — 무언가**: 앞 단계는 종결됐고 …")).toBe(false);
  });
});

describe("findCoordinatelessItems", () => {
  it("PR·상세 파일 둘 다 없는 활성 항목만 잡는다", () => {
    const board = [
      "# PROJECT_MASTER",
      "- **🔴 머지 대기 — A [PR #10](https://github.com/indexzigu/wagcrm_git/pull/10)**: …",
      "- **🖥️ 오너 육안 큐 (3건)**: 화면 확인할 것",
      "- **🔵 조사 완료·오너 결정 대기 — B**: … [상세](docs/handoff/b.md)",
      "- **✅ 종결 — C**: 로그 이관 대기",
      "- **📦 배칭 대기 큐**: 다음 PR 에 얹을 것",
    ].join("\n");

    const found = findCoordinatelessItems(board);
    expect(found.map((f) => f.lineNumber)).toEqual([3, 6]);
    expect(found[0].title).toContain("오너 육안 큐");
  });

  it("PR 링크가 있으면 좌표가 있는 것이다 — 상세 파일이 없어도 제외", () => {
    // PR 번호만 있어도 gh 로 재구성된다(사고 조사에서 실제로 그렇게 확인했다).
    const board = "- **🔴 머지 대기 — A [PR #10](https://github.com/indexzigu/wagcrm_git/pull/10)**: …";
    expect(findCoordinatelessItems(board)).toHaveLength(0);
  });

  it("평면 구역의 볼드 없는 새 형식도 좌표 경고 대상이다", () => {
    // 항목 인정 범위를 boardItemLines 와 공유하지 않으면, 대조에는 들어온 항목이
    // 좌표 경고에서만 조용히 빠진다 — 같은 침묵 실패의 반쪽이다.
    const board = "- 🔴 [슬러그] 좌표 없는 새 형식 항목 — 다음 게이트: 오너 확인";
    const [found] = findCoordinatelessItems(board);
    expect(found.lineNumber).toBe(1);
    // 제목에서 불릿 표식이 걷혀야 한다 — `- **` 만 걷던 종전 치환은 볼드 없는 새 형식에서
    // `- ` 를 남겨 보고서에 그대로 실렸다.
    expect(found.title).toBe("🔴 [슬러그] 좌표 없는 새 형식 항목 — 다음 게이트: 오너 확인");
  });

  it("하위 불릿·섹션 헤더는 항목이 아니다", () => {
    const board = [
      "## 오너 액션 큐",
      "  - 하위 불릿 — 좌표 없지만 항목이 아니다",
      "일반 문단",
    ].join("\n");
    expect(findCoordinatelessItems(board)).toHaveLength(0);
  });

  it("⚠️ 좌표 없음은 드리프트가 아니다 — 종료코드에 영향을 주지 않는다", () => {
    // 이 단언이 깨지면 도입 시점에 수십 건이 즉시 실패로 뜨고, 사람이 점검기를
    // 무시하기 시작한다. 차단으로 승격할지는 백로그가 빠진 뒤 오너가 판단한다.
    for (const verdict of DRIFT_VERDICTS) {
      expect(verdict).not.toBe("COORDINATELESS");
    }
    expect(Object.values(VERDICT)).not.toContain("COORDINATELESS");
  });
});

/**
 * 섹션 블록 인식 (2026-07-31 추가 — 이 도구가 낸 오탐 수정).
 *
 * 🪤 **도입 직후 실보드에서 오탐 2건이 났다.** 이 보드는 두 형식을 쓴다:
 *  - 평면 구역 — `- **상태 — 제목 [PR #N]**: … · 세션=xxx` 한 줄 = 한 항목
 *  - 섹션 블록 — `### 날짜 · 세션 xxx` 헤더 아래 `종결 2건`·`남은 게이트`·
 *    `다음 후보` 불릿이 딸린 **인계 묶음**. 귀속은 헤더에, 참조는 형제 줄에 있다.
 *
 * 줄 단위로만 보면 블록 불릿이 "PR 도 상세 파일도 없다"로 걸린다. 그런데 그 블록은
 * 헤더가 세션을 밝히고 형제 줄이 `PR #155`·`PROJECT_LOG` 를 가리켜 **한 줄이
 * 유실돼도 복구 경로가 남는다** — 이 경고가 재는 바로 그 조건이다.
 * 거짓 경보가 낡은 마커보다 해롭다는 것이 이 도구의 원칙인데 자신이 어기고 있었다.
 */
describe("splitBoardRegions — 평면 구역 vs 섹션 블록", () => {
  const BOARD = [
    "# PROJECT_MASTER",
    "- **평면 항목 A**: PR 없음",
    "- **평면 항목 B [PR #10](https://github.com/indexzigu/wagcrm_git/pull/10)**: …",
    "### 2026-07-30 · 세션 xxx",
    "- **종결 2건**: 이관 완료",
    "- **남은 게이트**: 오너 판단 3건",
    "- **소급 복원**: [PR #155](https://github.com/indexzigu/wagcrm_git/pull/155)",
  ].join("\n");

  it("첫 ### 이전은 평면, 이후는 섹션으로 가른다", () => {
    const { flat, sections } = splitBoardRegions(BOARD);
    expect(flat.filter((e) => e.line.startsWith("- **"))).toHaveLength(2);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toContain("세션 xxx");
    expect(sections[0].lines.filter((e: BoardLine) => e.line.startsWith("- **"))).toHaveLength(3);
  });

  it("줄번호는 1-기반으로 유지된다", () => {
    const { sections } = splitBoardRegions(BOARD);
    expect(sections[0].lines[0].lineNumber).toBe(5);
  });
});

describe("findCoordinatelessItems — 섹션 블록은 블록 단위로 판정", () => {
  it("블록 안 형제 줄이 PR 을 가지면 그 블록 불릿은 좌표 있음으로 본다", () => {
    // 실사고 재현: `남은 게이트`·`다음 후보` 가 형제 줄의 PR #155 덕에 복구 가능한데
    // 줄 단위 판정이 좌표 없음으로 잡았다.
    const board = [
      "# PROJECT_MASTER",
      "### 2026-07-30 · 세션 xxx",
      "- **남은 게이트**: 오너 판단 3건",
      "- **다음 후보**: 감사 BLOCK 축",
      "- **소급 복원**: [PR #155](https://github.com/indexzigu/wagcrm_git/pull/155)",
    ].join("\n");
    expect(findCoordinatelessItems(board)).toHaveLength(0);
  });

  it("블록 형제 줄이 PROJECT_LOG 를 가리켜도 인정한다", () => {
    const board = [
      "### 2026-07-30 · 세션 xxx",
      "- **남은 게이트**: 오너 판단 3건",
      "- **함정 모음**: 상세는 `PROJECT_LOG` 2026-07-23 두 줄",
    ].join("\n");
    expect(findCoordinatelessItems(board)).toHaveLength(0);
  });

  it("블록 전체에 아무 참조도 없으면 그 불릿들을 보고한다", () => {
    const board = [
      "### 2026-07-30 · 세션 xxx",
      "- **남은 게이트**: 오너 판단 3건",
      "- **다음 후보**: 감사 BLOCK 축",
    ].join("\n");
    expect(findCoordinatelessItems(board).map((f) => f.lineNumber)).toEqual([2, 3]);
  });

  it("⚠️ 평면 구역은 절대 블록으로 뭉치지 않는다 — PR 하나가 68건을 덮으면 안 된다", () => {
    // 이 단언이 깨지면 오탐을 고치다 **미탐**을 만든 것이다(훨씬 나쁘다).
    const board = [
      "# PROJECT_MASTER",
      "- **평면 항목 A**: PR 없음 · 상세 파일 없음",
      "- **평면 항목 B [PR #10](https://github.com/indexzigu/wagcrm_git/pull/10)**: …",
    ].join("\n");
    const found = findCoordinatelessItems(board);
    expect(found).toHaveLength(1);
    expect(found[0].lineNumber).toBe(2);
  });

  it("섹션 안 닫힌 항목은 블록에 참조가 없어도 제외한다", () => {
    const board = [
      "### 2026-07-30 · 세션 xxx",
      "- **✅ 종결 — 무언가**: 이관 대기",
      "- **남은 게이트**: 오너 판단",
    ].join("\n");
    expect(findCoordinatelessItems(board).map((f) => f.lineNumber)).toEqual([3]);
  });

  it("보고 순서는 줄번호 오름차순이다(평면·섹션이 섞여도)", () => {
    const board = [
      "# PROJECT_MASTER",
      "- **평면 좌표없음**: …",
      "### 2026-07-30 · 세션 xxx",
      "- **블록 좌표없음**: …",
    ].join("\n");
    expect(findCoordinatelessItems(board).map((f) => f.lineNumber)).toEqual([2, 4]);
  });
});

/**
 * 세 겹 PR 번호 — 구 레포 항목 (2026-08-29 상시 빨강).
 *
 * 🪤 **진짜 드리프트는 0건인데 점검기가 매번 26건을 외치고 있었다.** 이관이 두 번이라
 * (`wag-crm` → `wagcrm` → `wagcrm_git`, 매번 이력 없이 #1 부터) 보드가 참조하는 26건이
 * 전부 구 레포 번호인데, 조회는 현행 레포에서만 해서 전부 `PR_NOT_FOUND`(드리프트)로
 * 떨어졌다. **상시 빨강은 곧 안 보게 되고 그 학습이 진짜 드리프트까지 삼킨다** — 이
 * 도구가 막으려던 2026-07-29 사고(완료된 작업에 재착수 지시)가 정확히 그것이다.
 *
 * 처방의 핵심은 **보드를 고치지 않는 것**이다. 규약(P6)은 구 레포 번호를
 * `구레포#188(4e67fe6)` 로 한정하라 하지만 실보드는 이미 풀 URL 을 쓰고 있어(실측 83건
 * 전부) 레포 식별 정보가 보드 안에 있다. 보드는 git 미추적·다세션 공유라 26회 치환은
 * 그 자체가 P0 위험이다(2026-07-30 덮어쓰기 실사고) — 점검기가 링크를 읽으면 된다.
 *
 * 고정하는 계약:
 *   (F) 레포는 **링크가 밝힌다**. 번호만으로는 세 겹을 가를 수 없다.
 *   (G) 구 레포 항목은 `LEGACY_ARCHIVED`(드리프트 아님)이되, **고아 SHA 와 사유를 구분**
 *       한다 — 이관은 정상 상태이고 고아 SHA 는 2026-07-21 사고 잔여물이다.
 *   (H) **낡은 대기 마커는 구 레포에서도 잡는다** — 재착수 사고는 레포와 무관하다.
 *       이걸 빠뜨리면 26건을 조용하게 만드느라 탐지력까지 함께 끄는 셈이 된다.
 */
describe("primaryPr — 레포는 링크가 밝힌다 (F)", () => {
  it("구 레포 URL 이면 그 슬러그를 싣고 legacy 로 표시한다", () => {
    const [item] = parseBoardItems(
      "- **✅ 종결 — X [PR #226](https://github.com/indexzigu/wagcrm/pull/226)**: 내용",
    );
    expect(item.pr).toBe(226);
    expect(item.repo).toBe("indexzigu/wagcrm");
    expect(item.legacy).toBe(true);
  });

  it("현행 레포 URL 은 legacy 가 아니다(음성 대조군)", () => {
    const [item] = parseBoardItems(
      "- **✅ 종결 — X [PR #7](https://github.com/indexzigu/wagcrm_git/pull/7)**: 내용",
    );
    expect(item.repo).toBe("indexzigu/wagcrm_git");
    expect(item.legacy).toBe(false);
  });

  it("첫 이관 이전 레포(wag-crm)도 legacy 로 가른다 — 겹은 둘이 아니라 셋이다", () => {
    const [item] = parseBoardItems(
      "- **✅ 종결 — X [PR #188](https://github.com/indexzigu/wag-crm/pull/188)**: 내용",
    );
    expect(item.repo).toBe("indexzigu/wag-crm");
    expect(item.legacy).toBe(true);
  });

  it("슬러그 없는 맨 `pull/N` 은 현행 레포로 본다(새 항목의 기본값)", () => {
    const [item] = parseBoardItems("- **🔴 머지 대기 — X [PR #9](pull/9)**: 내용");
    expect(item.pr).toBe(9);
    expect(item.legacy).toBe(false);
  });

  it("⚠️ 번호가 같아도 레포가 다르면 다른 항목이다 — 세 겹 번호 함정", () => {
    const items = parseBoardItems(
      [
        "- **A [PR #188](https://github.com/indexzigu/wagcrm/pull/188)**: 구 레포",
        "- **B [PR #188](https://github.com/indexzigu/wagcrm_git/pull/188)**: 현행",
      ].join("\n"),
    );
    expect(items.map((i: { repo: string }) => i.repo)).toEqual([
      "indexzigu/wagcrm",
      "indexzigu/wagcrm_git",
    ]);
  });

  it("헤더 밖 본문 링크로 추정할 때도 레포를 함께 읽는다(신뢰도만 낮다)", () => {
    const [item] = parseBoardItems(
      "- **✅ 종결**: 상세는 [#212](https://github.com/indexzigu/wagcrm/pull/212) 참조",
    );
    expect(item.prConfident).toBe(false);
    expect(item.repo).toBe("indexzigu/wagcrm");
    expect(item.legacy).toBe(true);
  });
});

describe("classifyItem — 구 레포 항목 (G)(H)", () => {
  const legacyMerged = {
    state: "MERGED",
    merged: true,
    sha: "4e67fe6",
    legacy: true,
    repo: "indexzigu/wagcrm",
    shaKnown: false,
    inMain: false,
    inProd: null,
  };

  it("머지 확인된 구 레포 항목은 LEGACY_ARCHIVED 이고 드리프트가 아니다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      legacyMerged,
    );
    expect(r.verdict).toBe(VERDICT.LEGACY_ARCHIVED);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(false);
  });

  it("⚠️ 고아 SHA(UNKNOWN_SHA)와 사유를 구분한다 — 이관은 사고가 아니라 정상 상태다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: false },
      legacyMerged,
    );
    expect(r.verdict).not.toBe(VERDICT.UNKNOWN_SHA);
    expect(r.detail).toContain("indexzigu/wagcrm");
  });

  it("⚠️ 구 레포라도 낡은 대기 마커는 잡는다 — 26건을 조용하게 만드느라 탐지력을 끄지 않는다", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      legacyMerged,
    );
    expect(r.verdict).toBe(VERDICT.STALE_MERGE_MARKER);
    expect(DRIFT_VERDICTS.has(r.verdict)).toBe(true);
  });

  it("배포 대기 주장이 남은 구 레포 항목도 낡은 마커다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: true, deployed: false },
      legacyMerged,
    );
    expect(r.verdict).toBe(VERDICT.STALE_MERGE_MARKER);
  });

  it("미머지 구 레포 항목 + 대기 마커는 정확하므로 OK", () => {
    const r = classifyItem(
      { awaitingMerge: true, awaitingDeploy: false, deployed: false },
      { ...legacyMerged, state: "OPEN", merged: false, sha: null },
    );
    expect(r.verdict).toBe(VERDICT.OK);
  });

  it("⚠️ 조회 자체가 안 되면 여전히 드리프트다 — legacy 라고 무조건 접지 않는다", () => {
    const r = classifyItem(
      { awaitingMerge: false, awaitingDeploy: false, deployed: true },
      { state: "NOT_FOUND", merged: false, sha: null, legacy: true, repo: "indexzigu/wagcrm" },
    );
    expect(r.verdict).toBe(VERDICT.PR_NOT_FOUND);
    expect(r.detail).toContain("indexzigu/wagcrm");
  });
});

describe("보드 문구 → verdict 왕복 — 구 레포 26건 재현 (G)(H)", () => {
  const legacyLine = (status: string) =>
    `- **${status} — X [PR #226](https://github.com/indexzigu/wagcrm/pull/226)**: 내용`;
  const legacyFact = {
    ...merged("4e67fe6"),
    legacy: true,
    repo: "indexzigu/wagcrm",
    shaKnown: false,
    inMain: false,
    inProd: null,
  };
  const verdictOf = (status: string) =>
    classifyItem(readClaims(legacyLine(status)), legacyFact).verdict;

  it("`✅ 머지·승격·prod 배포 완료`(실보드 26건의 형태) → 드리프트가 아니다", () => {
    expect(verdictOf("✅ 머지·승격·prod 배포 완료")).toBe(VERDICT.LEGACY_ARCHIVED);
  });

  it("`🔴 PR 오너 머지 대기` → 낡은 마커(2026-07-29 사고 유형은 구 레포에서도 사고다)", () => {
    expect(verdictOf("🔴 PR 오너 머지 대기")).toBe(VERDICT.STALE_MERGE_MARKER);
  });
});
