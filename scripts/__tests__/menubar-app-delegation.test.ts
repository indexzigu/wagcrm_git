import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 메뉴바 앱은 얇은 화면이다 — 파괴적 동작은 전부 preview.sh 가 소유한다(설계 정본
 * docs/private/specs/2026-08-14-menubar-server-control-design.md).
 * Swift 소스가 docker/launchctl/rm 을 직접 부르면 preview.sh 안의 프로덕션
 * 보호 가드(라벨·경로 정확 일치, 심링크 거부, 삭제 전 확인, 사후조건 검증)를
 * 전부 우회한다. preview-control.test.ts 는 셸 스크립트만 보므로 앱 쪽 통로는
 * 이 계약이 막는다.
 */
const DIR = path.resolve(__dirname, "..", "..", "infra", "selfhost", "menubar", "Sources");

function swiftSources(): Array<[string, string]> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".swift"))
    .map((f) => [f, readFileSync(path.join(DIR, f), "utf8")]);
}

/** `//` 로 시작하는 줄만 걷어낸다 — 이 레포의 Swift 는 `///` 문서 주석만 쓴다.
 *  블록 주석(`/* */`)은 아래 단언이 부재를 고정하므로 이 단순 스트리퍼로 충분하다.
 *  ⚠️ 문자열 리터럴 안의 `//`(URL 등)를 건드리지 않으려고 **줄 시작**만 본다. */
function activeLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

describe("메뉴바 앱 위임 계약", () => {
  it("Swift 소스가 존재한다(스캐너 고장 감지)", () => {
    expect(swiftSources().length).toBeGreaterThanOrEqual(5);
  });

  it("블록 주석을 쓰지 않는다(위 스트리퍼의 전제)", () => {
    for (const [name, src] of swiftSources()) expect(src, name).not.toContain("/*");
  });

  it("docker·launchctl·rm 을 직접 부르지 않는다", () => {
    for (const [name, src] of swiftSources()) {
      // 실행 경로("/usr/local/bin/docker")든 인자 문자열("docker", "launchctl")이든
      // 따옴표/슬래시 바로 뒤에 오는 형태를 전부 잡는다.
      const active = activeLines(src);
      expect(active, name).not.toMatch(/["/](docker|launchctl)\b/);
      expect(active, name).not.toMatch(/\brm\s+-rf\b/);
    }
  });

  it("git·gh·wrangler 도 직접 부르지 않는다(릴리스 섹션)", () => {
    // 릴리스 판정·배포는 release-status.sh · release-deploy.sh 가 소유한다.
    // 앱이 직접 부르면 체크아웃 경로 소유·순서 보장·PATH 보강이 전부 무너진다.
    for (const [name, src] of swiftSources()) {
      const active = activeLines(src);
      expect(active, name).not.toMatch(/["/](git|gh|wrangler|npx|npm)\b/);
    }
  });

  it("양성 프로브 — 스캐너가 실제로 잡는다", () => {
    const violating = 'let x = "wrangler deploy"';
    expect(activeLines(violating)).toMatch(/["/](git|gh|wrangler|npx|npm)\b/);
    // 주석은 걷어내되, 걷어낸 뒤에도 실제 코드는 살아 있어야 한다.
    expect(activeLines('// wrangler 는 스크립트가 소유한다\nlet y = 1')).toContain("let y = 1");
    expect(activeLines("// wrangler deploy")).not.toMatch(/wrangler/);
  });

  it("프로덕션 launchd 라벨이 등장하지 않는다", () => {
    for (const [name, src] of swiftSources()) expect(src, name).not.toContain("kr.ygrd.wagcrm.app");
  });

  it("실행 진입점은 status.sh·metrics.sh·dev.sh·preview.sh·release-status.sh·release-deploy.sh 뿐이다", () => {
    const all = swiftSources()
      .map(([, s]) => s)
      .join("\n");
    expect(all).toContain("status.sh");
    // 리소스 계측(설계 개정 2) — status.sh 의 자매. 이 목록이 낡으면 다음
    // 세션이 "진입점 화이트리스트"를 오판한다(리뷰 지적, PR #390).
    expect(all).toContain("metrics.sh");
    expect(all).toContain("dev.sh");
    expect(all).toContain("preview.sh");
    // 릴리스 섹션(배포 대기·배포 실행) — Task 1·2 가 만든 셸 스크립트.
    expect(all).toContain("release-status.sh");
    expect(all).toContain("release-deploy.sh");
    expect(all).toContain("notify.sh");
    // Process 실행 대상은 bash 하나다 — 다른 바이너리를 직접 띄우지 않는다.
    const execTargets = all.match(/fileURLWithPath:\s*"([^"]+)"/g) ?? [];
    for (const t of execTargets) expect(t).toContain("/bin/bash");
  });
});

describe("알림 배선 계약", () => {
  const STORE = readFileSync(
    path.resolve(__dirname, "..", "..", "infra", "selfhost", "menubar", "Sources", "ServerStore.swift"),
    "utf8",
  );

  it("감시 목록에 preflightRunner 가 있다(오너 결정 2026-08-27)", () => {
    // ⛔ 되돌리려면 오너 결정을 뒤집는 것이다. 이 행이 error 인 상태는 「모든 PR 머지
    //    불가」 하나뿐이라(등록 0대 · online 0대) 화면 색으로만 알리면 자리를 비운 사이
    //    막힌 것을 모른다 — 그것이 이 행을 만든 이유 자체였다.
    const m = /let watched = \[([^\]]+)\]/.exec(STORE);
    expect(m, "watched 배열을 찾지 못했다(앵커 함정)").not.toBeNull();
    expect(m![1]).toContain('"preflightRunner"');
  });

  it("notifyOnNewErrors 의 감시 목록에 crons 가 있다", () => {
    // status.sh 가 crons 를 error 로 내도 이 배열에 없으면 알림이 영원히 안 뜬다 —
    // 신호는 있는데 전달이 없는 상태(2026-08-19 실사고의 본질)가 그대로 재현된다.
    const m = /let watched = \[([^\]]+)\]/.exec(STORE);
    expect(m, "watched 배열을 찾지 못했다(앵커 함정)").not.toBeNull();
    expect(m![1]).toContain('"crons"');
  });

  it("텔레그램 발송이 macOS 알림과 같은 전환 지점에서 나간다", () => {
    // 감시 목록을 따로 만들면 두 채널이 어긋난다 — 이 레포가 반복해 밟은
    // "같은 판정의 사본" 결함이다. watched 배열은 하나뿐이어야 한다.
    expect((STORE.match(/let watched = \[/g) ?? []).length).toBe(1);
    expect(STORE).toContain("notify.sh");
    // send 와 clear 가 모두 배선돼야 한다. send 만 있으면 alert-sent.tsv 기록이
    // 영원히 남아 회복 후 다시 나빠졌을 때 6시간을 기다리게 된다.
    expect(STORE).toMatch(/"send"/);
    expect(STORE).toMatch(/"clear"/);
  });

  it("clear 는 실제 전환에서만 나간다(매 폴링 호출 금지)", () => {
    // notifiedErrorKeys.remove(key) 의 반환값을 보고 호출해야 한다. 조건 없이 부르면
    // 초록인 항목마다 매 폴링(30초)에 프로세스가 하나씩 뜬다.
    expect(STORE).toMatch(/notifiedErrorKeys\.remove\(key\)\s*!=\s*nil/);
  });
});

/**
 * 배포 완료 알림 배선 계약 (설계 개정 5, 2026-08-27).
 *
 * 발화 조건은 **배포 마커 변화 하나**다 — 그래서 메뉴바 버튼 배포와 터미널
 * `release-deploy.sh` 실행이 같은 한 줄을 탄다(버튼 경로는 끝난 직후
 * `refreshRelease(force:)` 를 부르므로 즉시 뜬다). 판정과 문구는 전부
 * `release-status.sh` 가 소유하고 앱은 띄우기만 한다.
 *
 * ⛔ 성공 알림을 runLane 에도 넣지 말 것 — 버튼 배포만 2통이 된다.
 * ⛔ 텔레그램(notify.sh)으로 보내지 말 것 — 그쪽은 본문에 🔴 를 강제로 붙이고
 *    같은 키를 6시간에 1통으로 묶는 **서버 상태 경보** 레인이라, 하루 여러 번
 *    일어나는 배포는 두 번째부터 조용히 삼켜진다.
 */
describe("배포 완료 알림 배선 계약 (개정 5)", () => {
  const STORE = readFileSync(
    path.resolve(__dirname, "..", "..", "infra", "selfhost", "menubar", "Sources", "ServerStore.swift"),
    "utf8",
  );

  /** 함수 하나의 본문만 잘라낸다 — 앵커를 못 찾으면 **중단**한다(공허 통과 방지). */
  function slice(from: string, to: string): string {
    const a = STORE.indexOf(from);
    const b = STORE.indexOf(to, a + 1);
    expect(a, `앵커를 찾지 못했다: ${from}`).toBeGreaterThanOrEqual(0);
    expect(b, `끝 앵커를 찾지 못했다: ${to}`).toBeGreaterThan(a);
    return STORE.slice(a, b);
  }

  const refreshRelease = () => slice("func refreshRelease(", "private func notifyOnNewErrors");
  const runLane = () => slice("private func runLane(", "// MARK: - subprocess");

  it("마커를 프로세스 메모리로만 든다(디스크 저장 금지)", () => {
    // 저장하면 앱이 꺼져 있던 사이의 배포가 **나중에** 알림으로 뜬다 — 오너는
    // 그것을 방금 일어난 일로 읽는다. notifiedErrorKeys 와 같은 부류의 결정이다.
    expect(STORE).toMatch(/private var lastKnownMarker: String\?/);
    expect(refreshRelease()).not.toMatch(/UserDefaults|NSKeyedArchiver|\.write\(to:/);
  });

  it("직전 마커를 --deployed-since 로 되돌려 준다", () => {
    expect(refreshRelease()).toMatch(/lastKnownMarker\.map\s*\{\s*\["--deployed-since",\s*\$0\]\s*\}/);
  });

  it("첫 관측은 알리지 않는다 — 플래그를 무조건 붙이지 않는다", () => {
    // `?? []` 가 그 가드다: 마커를 모르는 동안엔 플래그가 없고, 스크립트는
    // deployed:null 을 돌려준다. 이게 없으면 앱을 켤 때마다 가짜 「배포 완료」가 뜬다.
    expect(refreshRelease()).toMatch(/\?\?\s*\[\]/);
  });

  it("문구를 앱이 조립하지 않는다 — 스크립트가 완성한 title·body 를 그대로 쓴다", () => {
    expect(refreshRelease()).toMatch(
      /postNotification\(title:\s*deployed\.title,\s*body:\s*deployed\.body\)/,
    );
  });

  it("같은 배포를 두 번 알리지 않는다 — 겹쳐 도는 조회가 있다(2026-08-27 교차 검증)", () => {
    // refreshRelease 는 호출 지점이 넷이다(기동·5분 타이머·패널 열기·배포 완료 force).
    // lastKnownMarker 갱신이 await 뒤라, 배포가 끝나는 순간 두 호출이 겹치면 둘 다 같은
    // 구 마커를 들고 출발해 **둘 다** 같은 배포를 발견한다. 최소 간격 가드는 "마지막
    // 호출이 시작된 시각"만 보므로 이 겹침을 못 본다.
    const src = refreshRelease();
    expect(src).toMatch(/deployed\.to != lastNotifiedDeployMarker/);
    // 표식은 발송 **전에** 찍혀야 뒤따라 들어온 호출이 그것을 보고 멈춘다.
    const mark = src.indexOf("lastNotifiedDeployMarker = deployed.to");
    const post = src.indexOf("postNotification(title: deployed.title");
    expect(mark, "표식 대입을 찾지 못했다(앵커 함정)").toBeGreaterThanOrEqual(0);
    expect(post, "발송 호출을 찾지 못했다(앵커 함정)").toBeGreaterThanOrEqual(0);
    expect(mark).toBeLessThan(post);
  });

  it("호출 지점이 늘면 이 계약을 다시 보라 — 현재 넷임을 고정한다", () => {
    // 위 중복 방지가 필요한 이유 자체가 「호출 지점이 여럿」이라는 사실이다. 새 호출부가
    // 생기면 겹침 창이 넓어지므로, 개수가 바뀌면 여기서 멈춰 다시 판단하게 한다.
    const sources = swiftSources()
      .map(([, s]) => activeLines(s))
      .join("\n");
    const calls = sources.match(/\brefreshRelease\(/g) ?? [];
    // 정의부 1 + 호출부 4
    expect(calls.length).toBe(5);
  });

  it("성공 알림은 refreshRelease 에서만 나간다(버튼 경로 중복 발송 금지)", () => {
    expect(runLane()).not.toMatch(/deployed\.(title|body)/);
    expect(runLane()).not.toContain("배포 완료");
  });

  it("실패 알림은 release 레인에서만 나간다", () => {
    const lane = runLane();
    expect(lane).toContain("배포 실패");
    // 레인 게이팅이 없으면 dev·preview 를 닫다 실패해도 「배포 실패」가 뜬다.
    expect(lane).toMatch(/if lane == "release"[\s\S]{0,400}배포 실패/);
  });

  it("배포 통지가 텔레그램으로 새지 않는다", () => {
    // notifyExternal 의 인자에 배포 관련 키가 등장하면 안 된다 — 그 레인은
    // 🔴 접두 + 6시간 하한이라 배포 사건에 구조적으로 안 맞는다.
    const calls = STORE.match(/notifyExternal\(\[[^\]]*\]\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const c of calls) expect(c).not.toMatch(/deploy|배포/i);
  });

  it("양성 프로브 — 앵커가 실제로 함수를 잡는다(공허 통과 방지)", () => {
    expect(refreshRelease()).toContain("releaseStatusScript");
    expect(runLane()).toContain("busyLane = lane");
    // 두 조각이 겹치지 않아야 위 「중복 발송 금지」 단언이 의미를 가진다.
    expect(runLane()).not.toContain("releaseStatusScript");
  });
});

/**
 * 화해(reconcile) 배선 계약 — I1: 앱이 죽어 있던 사이(크래시·재부팅) 항목이
 * 회복되면 notifiedErrorKeys(프로세스 메모리)가 그 전환을 본 적이 없어 clear 가
 * 안 나간다. 다음 진짜 빨강이 alert-sent.tsv 의 남은 기록에 걸려 최대
 * RESEND_MIN_INTERVAL_H(6시간) 조용히 삼켜진다. 기동 후 첫 full 폴링에서 1회
 * 화해를 돌아 이 남은 기록을 정리한다 — Swift 는 시뮬레이터 없이 실행할 수
 * 없으므로 소스 스캔으로 배선만 고정한다(behavioral 검증은 dead-man 판정 쪽의
 * heartbeat-wiring.test.ts 가 순수 함수 layer 에서 하는 것과 같은 타협).
 */
describe("화해(reconcile) 배선 계약 (I1)", () => {
  // 위 "알림 배선 계약" describe 블록의 STORE 는 그 콜백 스코프에 갇혀 있어 여기서
  // 참조할 수 없다 — 같은 방식으로 다시 읽는다("전달 계약" 블록의 폴백 경로와 동일).
  const STORE = readFileSync(
    path.resolve(__dirname, "..", "..", "infra", "selfhost", "menubar", "Sources", "ServerStore.swift"),
    "utf8",
  );

  it("reconcileExternalAlerts 가 존재하고 감시 목록을 새로 만들지 않는다", () => {
    const fn = /private func reconcileExternalAlerts\(\)\s*\{[\s\S]*?\n {4}\}/.exec(STORE);
    expect(fn, "reconcileExternalAlerts 함수를 찾지 못했다(앵커 함정)").not.toBeNull();
    // 별도 목록을 만들면 두 채널이 어긋난다 — notifyOnNewErrors 와 같은 배열(Self.watched)
    // 을 참조해야 한다("watched 배열은 하나뿐이어야 한다" 계약이 선언 자체는 고정한다).
    expect(fn![0]).toContain("Self.watched");
  });

  it("지금 error 가 아닌 키에만 clear 를 보낸다", () => {
    const fn = /private func reconcileExternalAlerts\(\)\s*\{[\s\S]*?\n {4}\}/.exec(STORE)![0];
    expect(fn).toMatch(/item\.level\s*!=\s*"error"/);
    expect(fn).toMatch(/"clear"/);
    expect(fn).not.toMatch(/"send"/); // 화해는 clear 전용이다 — 여기서 send 가 나가면 안 된다
  });

  it("앱 수명당 1회로 막는다(hasReconciled 가드)", () => {
    const fn = /private func reconcileExternalAlerts\(\)\s*\{[\s\S]*?\n {4}\}/.exec(STORE)![0];
    expect(fn).toMatch(/guard\s+!hasReconciled\s+else\s*\{\s*return\s*\}/);
    expect(fn).toMatch(/hasReconciled\s*=\s*true/);
  });

  it("기동 후 첫 full 폴링(!fast)에서 호출된다 — fast 30초에는 태우지 않는다", () => {
    expect(STORE).toMatch(/if\s+!fast\s*\{\s*reconcileExternalAlerts\(\)\s*\}/);
  });

  it("notify.sh probe 도 full 폴링에서만 부른다(C1)", () => {
    // notify.sh 가 시간당 1회로 자기 빈도를 제한하므로 앱은 그냥 매 full 폴링에
    // 부르면 된다 — 다만 fast(30초)에 태우면 그 제한과 무관하게 프로세스 수만 는다.
    expect(STORE).toMatch(/if\s+!fast\s*\{\s*notifyExternal\(\["probe"\]\)\s*\}/);
  });
});

/**
 * 일일 요약(digest) 배선 계약 — 전환 알림 1통을 놓치면 시스템이 다시 말하지 않던
 * 구멍을 닫는다(2026-08-25 실사고 #446: 크론이 나흘 연속 실패하는 동안 알림은
 * 전환 시점 1회뿐이었다). 하루 1회 "지금 빨강인 것"을 다시 보내므로 놓쳐도 다음
 * 날 다시 온다. 설계 정본:
 * docs/private/specs/2026-08-25-daily-red-digest-design.md
 */
describe("일일 요약(digest) 배선 계약 (#446)", () => {
  const STORE = readFileSync(
    path.resolve(__dirname, "..", "..", "infra", "selfhost", "menubar", "Sources", "ServerStore.swift"),
    "utf8",
  );
  const digestFn = (): string => {
    const m = /private func sendDailyDigestIfDue\(\)\s*\{[\s\S]*?\n {4}\}/.exec(STORE);
    expect(m, "sendDailyDigestIfDue 함수를 찾지 못했다(앵커 함정)").not.toBeNull();
    return m![0];
  };

  it("감시 목록을 새로 만들지 않는다 — Self.watched 를 그대로 쓴다", () => {
    // ⛔ 텔레그램용·요약용 목록을 따로 두면 disk 제외 같은 오너 결정이 한쪽에서만
    //    계승된다(외부채널 설계서의 ⛔ 조항). "watched 배열은 하나뿐" 계약과 짝이다.
    expect(digestFn()).toContain("Self.watched");
  });

  it("빨강(error)인 항목만 싣는다", () => {
    expect(digestFn()).toMatch(/level\s*==\s*"error"/);
  });

  it("빨강이 하나도 없으면 보내지 않는다(정상 운영 소음 0)", () => {
    // 매일 「전부 정상」이 오면 그 학습이 알림 전체를 무시하게 만든다 — 앞선 설계
    // 3건이 공통으로 기각한 것이다(warn 단계 알림 금지와 같은 근거).
    expect(digestFn()).toMatch(/isEmpty/);
  });

  it("notify.sh 의 digest 키로 나간다(별도 하한을 쓰는 그 키다)", () => {
    expect(digestFn()).toMatch(/"send",\s*"digest"/);
  });

  it("하루 1회로 막는다(오늘 표식 가드)", () => {
    expect(digestFn()).toMatch(/lastDigestDay/);
    expect(STORE).toMatch(/private var lastDigestDay/);
  });

  it("발송 시각 문턱은 Constants 가 소유한다(앱에 숫자를 박지 않는다)", () => {
    expect(digestFn()).toContain("Config.digestHour");
  });

  it("full 폴링에서만 호출된다 — fast 30초에는 태우지 않는다", () => {
    // probe·화해와 같은 형태의 독립 줄이다 — 그 둘의 기존 계약을 그대로 살려 둔다.
    expect(STORE).toMatch(/if\s+!fast\s*\{\s*sendDailyDigestIfDue\(\)\s*\}/);
  });

  it("양성 프로브 — 앵커 정규식이 실제로 함수를 잡는다(공허 통과 방지)", () => {
    expect(digestFn().length).toBeGreaterThan(120);
  });
});

describe("렌더 배선 계약 (C1 재발 방지)", () => {
  // status.sh 가 emit 하는 key 인데 앱이 어디에도 그리지 않으면, 신호는 나오는데
  // 화면엔 없는 상태가 그대로 재현된다(2026-08-19 crons 실사고 — warn/unknown 이
  // "회색 행"이 아니라 "존재하지 않는 행"이었다). 양쪽 다 하드코딩하지 않고 실 파일을
  // 스캔해서 비교한다 — 새 key 가 추가되는 순간 이 계약이 저절로 따라간다.
  const STATUS_SH = path.resolve(__dirname, "..", "..", "infra", "selfhost", "status.sh");
  const statusSrc = readFileSync(STATUS_SH, "utf8");
  const modelsSrc = readFileSync(path.join(DIR, "Models.swift"), "utf8");

  /** status.sh 가 실제로 emit 하는 key 전부(호출부만 — 정의부 `emit() {` 는 제외,
   *  `#` 로 시작하는 주석 줄도 제외). `emit key ...` 리터럴 호출과, 내부에서
   *  `emit "$key" ...` 로 위임하는 `backup_item key ...` 헬퍼 호출을 함께 잡는다. */
  function extractEmittedKeys(src: string): string[] {
    const active = src.split("\n").filter((l) => !l.trim().startsWith("#"));
    const keys = new Set<string>();
    for (const line of active) {
      // 앞에 오는 문자를 제한하지 않는다 — `case) emit key ...` 처럼 `)` 뒤에 오는
      // 호출부도 잡아야 한다(2026-08-19 리뷰 지적: prodLocal 이 case 분기에서만
      // emit 되는데 앞 문자 화이트리스트가 `)` 를 빠뜨려 놓쳤다). `emit() {` 처럼
      // 공백 없이 괄호가 오는 정의부는 여전히 매치하지 않는다(emit 뒤에 \s+ 를
      // 요구하기 때문).
      const literal = /\bemit\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (literal) keys.add(literal[1]);
      const viaHelper = /^\s*backup_item\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (viaHelper) keys.add(viaHelper[1]);
    }
    return [...keys];
  }

  /** 앱이 이 key 를 "안다"고 인정하는 두 경로: (1) 공통 행 렌더러가 도는 displayOrder,
   *  (2) devServer·preview 처럼 전용 섹션이 `store.items["key"]` 로 직접 집어 그리는
   *  경우. 후자를 빼면 이 계약이 정당한 설계(전용 섹션)까지 오탐으로 잡는다. */
  function keysHandledByApp(): Set<string> {
    const displayOrderMatch = /let displayOrder = \[([^\]]+)\]/.exec(modelsSrc);
    expect(displayOrderMatch, "displayOrder 를 찾지 못했다(앵커 함정)").not.toBeNull();
    const displayOrderKeys = [...displayOrderMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    const allSwift = swiftSources()
      .map(([, s]) => s)
      .join("\n");
    const dedicated = [...allSwift.matchAll(/items\[\s*"([^"]+)"\s*\]/g)].map((m) => m[1]);

    return new Set([...displayOrderKeys, ...dedicated]);
  }

  it("스캐너가 실제로 key 를 찾는다(공허 통과 방지)", () => {
    const emitted = extractEmittedKeys(statusSrc);
    // status.sh 가 emit 하는 key 는 최소 8개(prodLocal·prodExternal·db·devServer·
    // preview·backupDaily·backupWeekly·crons·disk) — 스캐너가 고장 나 빈 배열이면
    // 아래 "전부 렌더된다" 단언이 공허하게 통과한다.
    expect(emitted.length).toBeGreaterThanOrEqual(8);
    expect(emitted).not.toContain(""); // `emit() {` 정의부를 key 로 오인하지 않는다
  });

  it("status.sh 가 emit 하는 모든 key 가 패널 어딘가에 렌더된다", () => {
    const emitted = extractEmittedKeys(statusSrc);
    const handled = keysHandledByApp();
    const missing = emitted.filter((k) => !handled.has(k));
    expect(missing, `앱이 그리지 않는 key: ${missing.join(", ")}`).toEqual([]);
  });

  it("양성 프로브 — 안 그려지는 key 는 실제로 missing 으로 잡힌다", () => {
    // 실 파일을 건드리지 않고, 검사 로직이 정말로 결측을 잡는지를 합성 key 로 증명한다
    // (rules-planning 의 "앵커가 안 걸리면 무조건 통과" 함정 재현 방지).
    const handled = keysHandledByApp();
    const withFakeKey = [...extractEmittedKeys(statusSrc), "definitelyNotARenderedKey_control"];
    const missing = withFakeKey.filter((k) => !handled.has(k));
    expect(missing).toContain("definitelyNotARenderedKey_control");
  });
});

/**
 * 전달 계약 — `error` 를 낼 수 있는 key 는 알림 감시 목록(watched)에 있어야 한다.
 *
 * 렌더 계약(emit key ⊆ displayOrder)의 짝이다: 하나는 **보이는가**, 이쪽은 **전달되는가**.
 * 이 계약이 없어서 실제로 두 건이 새고 있었다 — backupWeekly 실패와 disk 부족이 화면에
 * 빨강으로만 뜨고 알림은 가지 않았다(2026-08-19 실측).
 */
describe("전달 계약 (error 가능 key ⊆ watched)", () => {
  // 위 "렌더 배선 계약" describe 블록의 statusSrc 는 그 콜백 스코프에 갇혀 있어 여기서
  // 참조할 수 없다 — 같은 방식으로 다시 읽는다(브리프의 폴백 경로).
  const STATUS_SH = path.resolve(__dirname, "..", "..", "infra", "selfhost", "status.sh");
  const statusSrc = readFileSync(STATUS_SH, "utf8");

  /** 알림을 의도적으로 보내지 않는 key. 비우지 말고 사유와 함께 남긴다. */
  const NOTIFY_EXEMPT = new Map<string, string>([
    ["disk", "오너 지시 — 디스크 잔여는 알리지 않고 화면 표시만 유지한다"],
  ]);

  /** `UNKNOWN_ESCALATABLE_KEYS` 상수를 소스 텍스트에서 파싱한다. error 로 가는 **세 번째**
   *  경로(지속 unknown 승격)가 여기서 온다 — literal `emit <key> error` 도 아니고
   *  `backup_item` 도 아니라 emit() 내부에서 변수로 level 을 덮어쓰기 때문에, 이 상수를
   *  빼면 이 계약에 구멍이 난다(리뷰 실측: escalatable 목록에만 있고 literal error emit 이
   *  없는 key(예: preview)를 추가해도 전체 스위트가 그린으로 통과했다).
   *  menubar-status.test.ts 의 "UNKNOWN_ESCALATABLE_KEYS 선언에 disk 가 없고 의도한 4개는
   *  있다" 테스트와 같은 앵커 정규식을 재사용한다 — 상수 이름이 바뀌면 여기서도 조용히
   *  통과하지 않고 똑같이 시끄럽게 실패해야 한다(앵커 함정 방지). */
  function escalatableKeysFromSource(src: string): string[] {
    const m = src.match(/^UNKNOWN_ESCALATABLE_KEYS="([^"]*)"/m);
    expect(m, "UNKNOWN_ESCALATABLE_KEYS 선언을 찾지 못했다(앵커 불일치 — 공허 통과 방지)").toBeTruthy();
    return m![1].split(/\s+/).filter(Boolean);
  }

  /** `emit <key> error` 와 backup_item(내부에서 error 를 낸다) 호출부를 모은다.
   *  `activeLines()` 는 Swift 용(`//` 스트리퍼)이라 bash 소스인 status.sh 에는
   *  안 맞는다(2026-08-19 리뷰 지적) — 렌더 계약의 extractEmittedKeys 와 같은
   *  방식으로 `#` 주석 줄을 직접 걷어낸다. */
  function directErrorCapableKeys(src: string): string[] {
    const active = src.split("\n").filter((l) => !l.trim().startsWith("#"));
    const keys = new Set<string>();
    for (const line of active) {
      // 앞에 오는 문자를 제한하지 않는다 — `case) emit key error ;;` 처럼 `)` 뒤에
      // 오는 호출부도 잡아야 한다. `emit() {` 정의부는 emit 뒤 \s+ 요구로 여전히
      // 제외된다.
      const direct = /\bemit\s+([A-Za-z_][A-Za-z0-9_]*)\s+error\b/.exec(line);
      if (direct) keys.add(direct[1]);
      const helper = /^\s*backup_item\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (helper) keys.add(helper[1]);
    }
    return [...keys];
  }

  /** error 에 실제로 닿을 수 있는 key 전부 — literal `emit <key> error` · backup_item
   *  위임 · 지속 unknown 승격(UNKNOWN_ESCALATABLE_KEYS) 세 경로의 합집합. 승격 경로를
   *  빼면 이 계약에 구멍이 난다(위 escalatableKeysFromSource 주석 참고). */
  function errorCapableKeys(src: string = statusSrc): string[] {
    return [...new Set([...directErrorCapableKeys(src), ...escalatableKeysFromSource(src)])];
  }

  function watchedKeys(): string[] {
    const m = /let watched = \[([^\]]+)\]/.exec(
      swiftSources().map(([, s]) => s).join("\n"),
    );
    expect(m, "watched 배열을 찾지 못했다(앵커 함정)").not.toBeNull();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }

  it("스캐너가 실제로 key 를 찾는다(공허 통과 방지)", () => {
    expect(errorCapableKeys().length).toBeGreaterThanOrEqual(5);
    expect(watchedKeys().length).toBeGreaterThanOrEqual(5);
  });

  it("양성 대조군 — case 분기에서만 emit 되는 key 도 잡힌다(prodLocal)", () => {
    // status.sh:66-67 은 `case ... in ""|000) emit prodLocal error ... ;;` 형태다.
    // emit 앞 문자가 `)` 라 예전 화이트리스트(^;|&()는 이 호출부를 놓쳤다 — prodLocal
    // 이 우연히 watched 에도 있어서 그동안 공허하게 통과했다(2026-08-19 리뷰 지적).
    // ghostKeyXYZ 같은 합성 append 는 이 case 경로를 전혀 행사하지 않으므로,
    // prodLocal 을 직접 지목해 회귀를 잡는다.
    expect(errorCapableKeys()).toContain("prodLocal");
  });

  it("error 를 낼 수 있는 key 는 전부 watched 이거나 명시 면제다", () => {
    const watched = new Set(watchedKeys());
    const leaking = errorCapableKeys().filter((k) => !watched.has(k) && !NOTIFY_EXEMPT.has(k));
    expect(
      leaking,
      `빨강이 될 수 있는데 알림이 안 가는 key: ${leaking.join(", ")} — watched 에 넣거나 NOTIFY_EXEMPT 에 사유와 함께 등재할 것`,
    ).toEqual([]);
  });

  it("면제 목록에 유령 key 가 없다(지운 key 의 면제가 남지 않게)", () => {
    const capable = new Set(errorCapableKeys());
    for (const key of NOTIFY_EXEMPT.keys()) expect(capable.has(key), `${key}`).toBe(true);
  });

  it("음성 대조군 — 승격 경로로만 닿는 key 도 잡는다(literal error emit 없이)", () => {
    // 리뷰가 실측한 구멍의 최소 재현: UNKNOWN_ESCALATABLE_KEYS 에는 있지만 literal
    // `emit <key> error` 도 backup_item 도 없는 key. 실 파일을 건드리지 않고 합성
    // 소스로 증명한다 — 이 union 이 실제로 집합을 넓히지 않으면(예: 승격 경로를
    // 빼먹으면) 이 테스트가 실패한다.
    const synthetic = 'UNKNOWN_ESCALATABLE_KEYS="db onlyEscalatable"\nemit db ok "제목" "본문"\n';
    expect(directErrorCapableKeys(synthetic), "직접 경로만으로는 안 잡혀야 정상").not.toContain(
      "onlyEscalatable",
    );
    expect(errorCapableKeys(synthetic)).toContain("onlyEscalatable");
  });

  it("양성 대조군 — 감시되지 않는 key 를 넣으면 잡힌다", () => {
    const watched = new Set(watchedKeys());
    const fake = ["ghostKeyXYZ", ...watched];
    const leaking = fake.filter((k) => !watched.has(k) && !NOTIFY_EXEMPT.has(k));
    expect(leaking).toEqual(["ghostKeyXYZ"]);
  });
});
