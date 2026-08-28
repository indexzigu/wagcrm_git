import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 빌드 트리와 서빙 트리 분리 계약 (실사고 2026-08-29).
 *
 * **무엇이 났나:** `deploy.sh` 는 앱을 내리지 않은 채 `npm run build` 를 돌렸고, Next 는
 * `cleanDistDir: true` 라 빌드 시작 시 `.next` 를 통째로 비운다. 그런데 앱은 바로 그
 * `.next/standalone/server.js` 로 서빙 중이었다 — 살아 있는 구 프로세스가 지연 로딩하려던
 * 청크·클라이언트 참조 매니페스트가 사라져, 빌드가 도는 **63초 내내** 들어온 요청이 죽었다
 * (InvariantError 6건 · ChunkLoadError 2건 · 자정 크론 동반 실패).
 *
 * **왜 소스 앵커로 고정하나:** 이 결함은 "배포 중에 요청이 들어와야" 드러나는 경합이라
 * 평시 테스트로는 영원히 초록이다. 실제로 이 레포는 그 63초를 여러 번 지나오면서 한 번도
 * 실패를 보지 못했다 — 자정 크론과 정면으로 겹친 날에야 드러났다. 그래서 판정을 "증상이
 * 나는가"가 아니라 **"구조가 유지되는가"** 로 옮긴다.
 *
 * ⛔ 이 계약을 "빌드가 잘 되니 불필요하다"로 읽지 말 것 — 빌드 성공은 이 결함과 무관하다.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INFRA = path.join(REPO_ROOT, "infra", "selfhost");
const runApp = readFileSync(path.join(INFRA, "run-app.sh"), "utf8");
const deploy = readFileSync(path.join(INFRA, "deploy.sh"), "utf8");
const preview = readFileSync(path.join(INFRA, "preview.sh"), "utf8");

describe("run-app.sh — 서빙은 릴리스 경로에서 한다", () => {
  it("`.live/current/server.js` 를 먼저 실행한다", () => {
    expect(runApp).toContain('LIVE_ENTRY="$PWD/.live/current/server.js"');
    expect(runApp).toMatch(/exec "\$NODE_BIN" "\$LIVE_ENTRY"/);
  });

  it("릴리스 우선 실행이 빌드 트리 폴백보다 **앞**에 있다", () => {
    // 순서가 뒤집히면 폴백이 언제나 이겨서, 이 변경 전체가 무효가 된다.
    const liveAt = runApp.indexOf('exec "$NODE_BIN" "$LIVE_ENTRY"');
    const fallbackAt = runApp.indexOf(
      'exec "$NODE_BIN" .next/standalone/server.js',
    );
    expect(liveAt, "릴리스 실행 경로를 찾지 못했다").toBeGreaterThan(-1);
    expect(fallbackAt, "폴백 경로를 찾지 못했다").toBeGreaterThan(-1);
    expect(liveAt).toBeLessThan(fallbackAt);
  });

  it("릴리스가 없어도 **죽지 않고** 경고를 남긴 뒤 폴백한다", () => {
    // plist 가 KeepAlive 라 여기서 exit 하면 10초마다 재시도하는 크래시루프 =
    // 서비스 전면 정지다. 가용성을 택하되, 무증상으로 굳지 않도록 반드시 시끄러워야 한다.
    expect(runApp).toContain("[run-app] ⚠️ 경고:");
    expect(runApp).toMatch(/echo "\[run-app\][^"]*" >&2/);
    // 폴백 직전에 `exit 1` 같은 중단이 끼어들면 위 의도가 깨진다.
    const warnAt = runApp.indexOf("[run-app] ⚠️ 경고:");
    const fallbackAt = runApp.indexOf(
      'exec "$NODE_BIN" .next/standalone/server.js',
    );
    expect(runApp.slice(warnAt, fallbackAt)).not.toMatch(/\bexit\s+1\b/);
  });
});

describe("deploy.sh — 완성된 산출물만 서빙 트리로 들어간다", () => {
  it("standalone 을 릴리스 폴더로 **옮긴다**(복사가 아니라)", () => {
    // 복사면 빌드 트리에 원본이 남아 "어느 쪽이 서빙 중인가"가 둘로 갈린다.
    // 같은 파일시스템 rename 이라 즉시 끝나는 것도 이 방식의 요점이다(교체 창 최소화).
    expect(deploy).toContain(
      'mv .next/standalone "$LIVE_DIR/releases/$RELEASE_ID"',
    );
  });

  it("심링크 교체를 tmp + rename 으로 하고, `mv` 가 링크를 따라가지 않는다", () => {
    // `ln -sfn` 은 unlink 후 create 라 원자적이지 않다 — 그 찰나에 재기동이 겹치면
    // 링크 없는 상태로 뜬다. 그래서 tmp 를 만들고 rename 한다.
    expect(deploy).toContain(
      'ln -sfn "releases/$RELEASE_ID" "$LIVE_DIR/current.tmp"',
    );
    // 🪤 "대상 심링크를 따라가지 않는다" 옵션이 빠지면 **조용히 실패한다**: 대상
    // `current` 가 이미 디렉터리를 가리키는 심링크면 `mv` 는 링크를 따라가 tmp 를 그
    // 디렉터리 **안으로** 옮기고 exit 0 을 낸다. 링크는 옛 릴리스를 계속 가리키는데
    // 배포는 성공으로 보인다 — 첫 배포만 우연히 맞고(대상 부재) 그 뒤로는 영영 갱신되지
    // 않는다. 실행 검증에서 실제로 잡았다: 4회 교체 후 current 가 1회차를 가리켰고
    // `releases/<1회차>/current.tmp` 가 남았다.
    // ⚠️ 옵션 이름이 구현마다 다르다(BSD `-h` · GNU `-T`). 한쪽으로 고정하면 행위 계약이
    // CI(Linux)에서 못 돈다 — `-h` 고정판이 실제로 `invalid option` 으로 넘어졌다.
    expect(deploy).toContain(
      'if mv --version >/dev/null 2>&1; then MV_NOFOLLOW="-T"; else MV_NOFOLLOW="-h"; fi',
    );
    expect(deploy).toContain(
      'mv -f "$MV_NOFOLLOW" "$LIVE_DIR/current.tmp" "$LIVE_DIR/current"',
    );
    expect(
      deploy,
      "옵션 없는 mv 는 심링크를 따라가 교체를 조용히 무효로 만든다",
    ).not.toContain('mv -f "$LIVE_DIR/current.tmp"');
  });

  it("기존 릴리스 폴더를 **절대 덮어쓰지 않는다**", () => {
    // FORCE=1 재배포는 같은 SHA 로 다시 도는데, 그 폴더가 바로 **지금 서빙 중인 릴리스**다.
    // 지우면 이 스크립트가 고치려는 사고를 스스로 일으킨다.
    expect(deploy).toMatch(
      /while \[ -e "\$LIVE_DIR\/releases\/\$RELEASE_ID" \]; do/,
    );
    expect(deploy).toContain('RELEASE_ID="$AFTER-$RELEASE_SEQ"');
    expect(
      deploy,
      "릴리스 폴더를 선제 삭제하면 서빙 중인 트리를 지울 수 있다",
    ).not.toContain('rm -rf "$LIVE_DIR/releases/$RELEASE_ID"');
  });

  it("릴리스 교체가 kickstart **앞**, 경로 확인이 **뒤**에 온다", () => {
    // 교체가 뒤면 새 프로세스가 옛 릴리스로 뜨고, 확인이 앞이면 아무것도 증명하지 못한다.
    const swapAt = deploy.indexOf(
      'mv .next/standalone "$LIVE_DIR/releases/$RELEASE_ID"',
    );
    const kickAt = deploy.indexOf("launchctl kickstart -k");
    const verifyAt = deploy.indexOf(
      'RUNNING_CMD="$(ps -o command= -p "$PID_AFTER"',
    );
    expect(swapAt).toBeGreaterThan(-1);
    expect(kickAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(swapAt, "릴리스 교체가 kickstart 뒤에 있다").toBeLessThan(kickAt);
    expect(verifyAt, "경로 확인이 kickstart 앞에 있다").toBeGreaterThan(kickAt);
  });

  it("새 프로세스가 릴리스 경로로 떴는지 확인하고, 아니면 배포를 실패시킨다", () => {
    // run-app.sh 의 폴백이 조용히 굳으면 경합이 그대로 살아 있는 채 배포는 매번 초록이다.
    // 이 레포가 반복해서 밟은 「무증상 열화」 형태라 탐지 장치를 짝으로 둔다.
    expect(deploy).toContain('LIVE_ENTRY="$LIVE_DIR/current/server.js"');
    expect(deploy).toMatch(
      /if \[\[ "\$RUNNING_CMD" != \*"\$LIVE_ENTRY"\* \]\]; then/,
    );
    const verifyAt = deploy.indexOf(
      'if [[ "$RUNNING_CMD" != *"$LIVE_ENTRY"* ]]; then',
    );
    expect(deploy.slice(verifyAt, verifyAt + 700)).toMatch(/exit 1/);
  });

  it("마커는 릴리스 경로 확인을 통과한 뒤에만 기록된다", () => {
    // 마커는 "지금 서빙되는 커밋"의 SSOT 다(P6 Deployment Verification ②).
    // 확인보다 먼저 쓰면 폴백으로 뜬 배포까지 "정상 배포"로 기록된다.
    const verifyAt = deploy.indexOf(
      'RUNNING_CMD="$(ps -o command= -p "$PID_AFTER"',
    );
    const markerAt = deploy.indexOf(
      'printf \'%s\\n\' "$AFTER" > "$MARKER_FILE"',
    );
    expect(markerAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(verifyAt);
  });

  it("오래된 릴리스를 정리하되 현재 링크 대상은 건드리지 않는다", () => {
    expect(deploy).toContain('RELEASE_KEEP="${RELEASE_KEEP:-3}"');
    expect(deploy).toContain('[ "$REL" = "$CURRENT_ID" ] && continue');
    // 정리는 헬스체크·DB 프로브까지 끝난 뒤여야 한다 — 먼저 지우면 롤백 여지를 잃은 채
    // 실패하는 경우가 생긴다.
    const healthAt = deploy.indexOf('echo "[deploy] 헬스체크"');
    const pruneAt = deploy.indexOf('RELEASE_KEEP="${RELEASE_KEEP:-3}"');
    expect(pruneAt).toBeGreaterThan(healthAt);
  });
});

describe("서빙 트리의 데이터 등급", () => {
  it("`.gitignore` 가 `/.live/` 를 무시한다", () => {
    // 프리뷰 레인의 서빙 트리에는 **프로덕션 사본 DB 로 프리렌더된 페이지**가 들어간다.
    // 추적 후보가 되면 다음 세션의 `git add -A` 한 번으로 커밋된다(P0).
    const ignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\/\.live\/$/m);
  });

  it("preview.sh down 이 `.next` 와 `.live` 를 **둘 다** 지운다", () => {
    // `.next` 만 지우면 「잔여 사본 0」(오너 확정 2026-08-13)이 데이터의 절반에만 적용된다 —
    // 안전장치 ⑧ 이후 프리렌더 산출물의 실제 사본은 `.live` 쪽에 있다.
    expect(preview).toContain('rm -rf "$PREVIEW_CHECKOUT/.next"');
    expect(preview).toContain('rm -rf "$PREVIEW_CHECKOUT/.live"');
    // 남았을 때 사람에게 말해주는 최종 확인도 짝으로 있어야 한다.
    expect(preview).toContain('if [ -e "$PREVIEW_CHECKOUT/.live" ]; then');
  });
});
