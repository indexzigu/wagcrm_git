import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * preview.sh 는 프로덕션과 **같은 docker 데몬·같은 launchd 도메인·같은 파일
 * 시스템**을 조작한다. 최악 사고 3종을 소스 계약으로 막는다:
 *   (A) `docker rm -f supabase-db` — 프로덕션 DB 컨테이너 삭제.
 *   (B) `launchctl bootout … kr.ygrd.wagcrm.app` — 프로덕션 앱 정지. 라벨 한 글자
 *       차이이고, bootout 은 서비스 정의 자체를 제거하므로 KeepAlive 로도 복구되지
 *       않는다.
 *   (C) `rm -rf <프로덕션 체크아웃>` — down 이 프리뷰 빌드 산출물을 재귀 삭제하게
 *       되면서 새로 생긴 부류다. 프로덕션 체크아웃(~/selfhost/wagcrm)을 잡으면
 *       프로덕션 앱의 소스와 빌드가 함께 사라진다.
 * 세 계약 모두 "파괴적 줄이 0건이면 실패"(스캐너 고장 감지)를 유지한다 — 정규식이
 * 낡아 아무것도 안 잡게 되면 계약이 조용히 무력화되기 때문이다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "preview.sh");

function activeLines(src: string): string[] {
  return src.split("\n").filter((l) => !l.trim().startsWith("#"));
}

/**
 * 셸 함수 하나의 본문만 잘라낸다. 순서를 보는 계약은 반드시 이걸로 범위를 좁혀야 한다 —
 * `preview.sh` 는 같은 폴링 코드를 `cmd_up`·`cmd_down` 양쪽에 갖고 있어서, 파일 전체로
 * 위치를 비교하면 다른 함수의 줄을 기준으로 삼게 된다.
 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name}() 를 찾지 못했다 — 계약 기준을 갱신할 것`);
  const end = src.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`${name}() 의 끝을 찾지 못했다 — 계약 기준을 갱신할 것`);
  return src.slice(start, end);
}

/**
 * 프로덕션 체크아웃 경로를 **정확히** 잡는 패턴.
 *
 * ⚠️ 여기가 이 파일에서 가장 틀리기 쉬운 지점이다. 프로덕션 체크아웃
 * `$HOME/selfhost/wagcrm` 은 프리뷰 체크아웃 `$HOME/selfhost/wagcrm-preview` 의
 * **접두사**라, 단순 부분일치(`src.includes("selfhost/wagcrm")`)로 쓰면 정당한
 * 프리뷰 경로에 걸려 늘 실패한다(위양성 → 계약이 곧 삭제된다). 반대로 접두사를
 * 피하려고 `"/wagcrm/"` 처럼 뒤에 슬래시를 붙여 좁히면 `…/wagcrm"` 같은 표기를
 * 놓친다(위음성 → 진짜 사고를 통과시킨다).
 * 그래서 경로 세그먼트의 **끝**을 부정 선행으로 못 박는다 — `wagcrm` 뒤에 경로
 * 이름을 이어갈 수 있는 글자가 오면(=`wagcrm-preview` 처럼 다른 이름이면) 매치하지
 * 않고, 슬래시·따옴표·공백·줄끝이면 매치한다.
 */
const PROD_CHECKOUT_RE = /(?:\$HOME|\$\{HOME\}|~)\/selfhost\/wagcrm(?![A-Za-z0-9._-])/;

describe("preview.sh 파괴 명령 가드", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("파괴적 docker 명령이 프로덕션 컨테이너를 가리키지 않는다", () => {
    const destructive = activeLines(src).filter((l) => /docker\s+(rm|stop|kill)/.test(l));
    expect(destructive.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const line of destructive) {
      expect(line, `파괴적 docker 명령이 프로덕션 컨테이너를 가리킨다: ${line}`).not.toContain("supabase-db");
    }
  });

  it("파괴적 launchctl 명령이 프로덕션 라벨을 가리키지 않는다", () => {
    const destructive = activeLines(src).filter((l) => /launchctl\s+(bootout|kill|unload)/.test(l));
    expect(destructive.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const line of destructive) {
      expect(line, `파괴적 launchctl 명령이 프로덕션 앱을 가리킨다: ${line}`).not.toContain("kr.ygrd.wagcrm.app");
    }
  });

  it("프로덕션 라벨은 변수 값으로도 등장하지 않는다", () => {
    // 파괴적 줄이 "$PROD_LABEL" 같은 변수를 쓰면 위 두 계약이 못 잡는다 —
    // 프로덕션 라벨 리터럴 자체가 이 파일에 없어야 그 우회가 원천 봉쇄된다.
    // (참조 전용 상수로도 두지 않는다 — preview.sh 는 프로덕션을 알 필요가 없다.)
    expect(activeLines(src).join("\n")).not.toContain("kr.ygrd.wagcrm.app");
  });

  it("프로덕션 컨테이너 이름은 줄바꿈으로 우회해도 등장하지 않는다", () => {
    // 위 docker 가드는 "파괴적 줄"에만 스캔을 좁히는데, 그 좁힘 자체가 구멍이다 —
    //   docker rm -f \
    //     supabase-db
    // 처럼 줄바꿈되면 activeLines() 가 "docker rm -f \\" 만 파괴적 줄로 잡고
    // "supabase-db" 는 다음 줄이라 놓친다(실제로는 여전히 프로덕션 DB 를 삭제하는
    // 명령이다). launchctl 라벨 가드와 동일하게, 줄 경계와 무관한 전역 리터럴
    // 부재로 이 우회를 원천 봉쇄한다.
    expect(activeLines(src).join("\n")).not.toContain("supabase-db");
  });

  it("재귀 삭제 대상이 허용 목록 안에만 있다", () => {
    // down 이 프리뷰 빌드 산출물(.next)을 지우면서 이 파일에 재귀 삭제가 들어왔다.
    // 2026-08-29 에 서빙 트리(.live)가 두 번째 대상으로 추가됐다 — deploy.sh 안전장치 ⑧
    // 이후 프리렌더 산출물의 **실제 사본**이 그쪽에 있어, 안 지우면 「잔여 사본 0」이
    // 데이터의 절반에만 적용된다(오너 확정 2026-08-13). 목록을 넓히는 이 편집 자체가
    // 이 계약이 요구하는 「사람이 보는」 절차다.
    //
    // ⚠️ "대상이 $PREVIEW_CHECKOUT 로 시작하는지"만 보는 것은 **불충분하다** — 그건
    // 접두사가 가드됐다는 뜻이지 **대상**이 가드됐다는 뜻이 아니다. 실제로
    // `"$PREVIEW_CHECKOUT/../wagcrm/.next"` 로 바꾸면 그 검사도, 프로덕션 경로 리터럴
    // 검사도 전부 통과하는데 런타임에는 프로덕션 체크아웃으로 해석된다(실측).
    // 그래서 **허용 목록과의 정확 일치**로 못 박는다: 이 스크립트가 재귀 삭제해도 되는
    // 경로는 하나뿐이므로, 새 대상을 추가하려면 이 목록을 손대야 하고 그때 사람이 본다.
    // ⛔ 둘 다 체크아웃 **바로 아래 한 단계**여야 한다 — 위 심링크·물리경로·.git 3중
    //    가드가 검증하는 것은 $PREVIEW_CHECKOUT 자신이므로, 그보다 깊거나 밖으로 나가는
    //    대상은 그 가드가 덮지 못한다.
    const ALLOWED_TARGETS = ['"$PREVIEW_CHECKOUT/.next"', '"$PREVIEW_CHECKOUT/.live"'];

    const destructive = activeLines(src).filter((l) => /\brm\s+-[A-Za-z]*r/.test(l));
    expect(destructive.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const line of destructive) {
      expect(line, `재귀 삭제가 프로덕션 체크아웃을 가리킨다: ${line}`).not.toMatch(
        PROD_CHECKOUT_RE,
      );
      // `rm -rf <대상>` 에서 대상 하나만 뽑는다. 뒤에 `|| true` 가 붙는 형태까지만
      // 허용한다 — 그 밖의 형태(대상 여러 개, 파이프, 추가 인자)는 파싱에 실패해
      // 아래 단언에서 잡힌다.
      const m = line.trim().match(/^rm\s+-[A-Za-z]+\s+("[^"]*"|\S+)(?:\s*\|\|\s*true)?$/);
      expect(m, `재귀 삭제 줄의 형태를 해석하지 못했다(대상을 확정할 수 없음): ${line}`)
        .not.toBeNull();
      const target = m![1];
      expect(target, `경로 탈출(..)이 섞인 재귀 삭제 대상: ${line}`).not.toContain("..");
      expect(
        ALLOWED_TARGETS,
        `허용되지 않은 재귀 삭제 대상: ${target} — 허용 목록을 넓히려면 이 계약을 먼저 고칠 것`,
      ).toContain(target);
    }
  });

  it("프로덕션 체크아웃 경로는 줄바꿈으로 우회해도 등장하지 않는다", () => {
    // docker·launchctl 백스톱과 같은 이유다: 위 스캔은 "파괴적 줄"로 범위를 좁히므로
    //   rm -rf \
    //     "$HOME/selfhost/wagcrm"
    // 처럼 줄이 갈리면 대상 경로가 다음 줄로 빠져나간다. 줄 경계와 무관한 전역
    // 부재로 원천 봉쇄한다. 프리뷰 경로(가드에 리터럴로 등장한다)는 통과해야 하므로
    // 부분일치가 아니라 위 정확 패턴을 쓴다.
    expect(activeLines(src).join("\n")).not.toMatch(PROD_CHECKOUT_RE);
  });

  it("경로 패턴이 접두사 함정을 실제로 가른다", () => {
    // 위 두 계약은 패턴이 옳을 때만 의미가 있다. 패턴이 프리뷰 경로에도 걸리면
    // 계약이 늘 실패해 곧 삭제되고, 프로덕션 경로를 놓치면 계약이 아무것도 막지
    // 못한다. 둘 다를 합성 문자열로 직접 확인한다(스캐너 고장 감지의 경로판).
    expect('rm -rf "$HOME/selfhost/wagcrm/.next"').toMatch(PROD_CHECKOUT_RE);
    expect('rm -rf "$HOME/selfhost/wagcrm"').toMatch(PROD_CHECKOUT_RE);
    expect("rm -rf ~/selfhost/wagcrm").toMatch(PROD_CHECKOUT_RE);
    expect('rm -rf "${HOME}/selfhost/wagcrm/.next"').toMatch(PROD_CHECKOUT_RE);
    expect('rm -rf "$HOME/selfhost/wagcrm-preview/.next"').not.toMatch(PROD_CHECKOUT_RE);
    expect('PREVIEW_CHECKOUT="$HOME/selfhost/wagcrm-preview"').not.toMatch(PROD_CHECKOUT_RE);
  });

  it("프리뷰 env 의 DB 확인이 DB 재구축·서비스 로드보다 앞에 온다", () => {
    // 프리뷰 레인의 실행 env 는 호스트 로컬 파일이라 이 레포가 고칠 수 없다. 그 값이
    // 프로덕션 DB 를 가리키면 deploy.sh 가 프로덕션에 마이그레이션을 걸고 프리뷰 앱이
    // 프로덕션 데이터를 만진다(deploy.sh 의 host 가드는 127.0.0.1 을 통과시킨다).
    // 2026-08-25 이후 실제로 그 상태였고, 프리뷰 DB 가 같은 포트를 잡으려다 실패해
    // 레인이 안 뜬 것만이 제동이었다 — 포트를 옮기면 그 제동이 풀리므로 이 검사가
    // 그 자리를 대신한다. 확인은 반드시 docker·launchd 를 건드리기 **전**이어야 한다.
    const lines = activeLines(functionBody(src, "cmd_up"));
    const envCheckIdx = lines.findIndex((l) => /env_hostport.*PREVIEW_DB_HOSTPORT|PREVIEW_DB_HOSTPORT.*env_hostport/.test(l));
    const dbRebuildIdx = lines.findIndex((l) => /preview-db\.sh/.test(l));
    const bootstrapIdx = lines.findIndex((l) => /launchctl\s+bootout|launchctl\s+bootstrap/.test(l));

    expect(envCheckIdx, "프리뷰 env 의 DB 확인을 찾지 못했다 — 계약 기준을 갱신할 것").toBeGreaterThan(-1);
    expect(dbRebuildIdx, "preview-db.sh 호출을 찾지 못했다").toBeGreaterThan(-1);
    expect(bootstrapIdx, "launchctl 조작을 찾지 못했다").toBeGreaterThan(-1);
    expect(dbRebuildIdx, "DB 재구축이 env 확인보다 앞에 있다").toBeGreaterThan(envCheckIdx);
    expect(bootstrapIdx, "서비스 로드가 env 확인보다 앞에 있다").toBeGreaterThan(envCheckIdx);
  });

  it("프리뷰 env 검사가 DATABASE_URL 과 DIRECT_URL 을 모두 본다", () => {
    // scripts/prisma-migrate-on-deploy.mjs 는 `DIRECT_URL || DATABASE_URL` 순으로
    // 마이그레이션 대상을 고른다. 그래서 DATABASE_URL 만 검사하면 DATABASE_URL 은
    // 프리뷰인데 DIRECT_URL 이 프로덕션인 구성이 가드를 통과하고, 프리뷰 배포가
    // **프로덕션에 migrate deploy 를 건다.** 한쪽만 보는 회귀를 여기서 잡는다.
    const body = functionBody(src, "cmd_up");
    const lines = activeLines(body);
    const loop = lines.find((l) => /^\s*for\s+key\s+in\b/.test(l));
    expect(loop, "env 검사 루프를 찾지 못했다 — 계약 기준을 갱신할 것").toBeDefined();
    expect(loop, "DATABASE_URL 이 검사 대상에서 빠졌다").toContain("DATABASE_URL");
    expect(loop, "DIRECT_URL 이 검사 대상에서 빠졌다").toContain("DIRECT_URL");

    // 루프가 두 키를 나열하는 것만으로는 부족하다 — grep 패턴이 `${key}` 가 아니라
    // 한쪽 이름을 하드코딩하고 있으면 루프를 돌아도 같은 변수만 두 번 본다.
    // 그 형태의 되돌림은 위 단언을 전부 통과하므로 여기서 따로 잡는다.
    const probe = lines.find((l) => /env_hostport=/.test(l));
    expect(probe, "env 값 추출 줄을 찾지 못했다 — 계약 기준을 갱신할 것").toBeDefined();
    expect(probe, "grep 패턴이 루프 변수를 쓰지 않는다").toMatch(/\$\{?key\}?/);
    expect(probe, "grep 패턴에 키 이름이 하드코딩돼 있다").not.toMatch(/(DATABASE_URL|DIRECT_URL)=/);

    // 이 파일은 셸이 소스하므로 같은 변수가 여러 번 나오면 **마지막 할당이 이긴다.**
    // `head -1` 로 첫 줄을 보면 "프리뷰 다음 줄에 프로덕션" 인 파일이 가드를 통과한 채
    // 앱과 마이그레이션은 프로덕션으로 간다.
    expect(probe, "마지막 할당이 아니라 첫 할당을 본다 — 셸의 실제 값과 어긋난다").toContain("tail -1");
    expect(probe, "head -1 은 셸이 쓰는 값과 다른 줄을 본다").not.toContain("head -1");
  });

  it("파일 삭제가 launchd 언로드 확인보다 뒤에 온다", () => {
    // `bootout` 은 비동기다. 언로드를 확인하기 전에 지우면 아직 살아 있는 앱 프로세스와
    // 경합한다 — 프리뷰 앱은 체크아웃 안의 standalone 서버로 돌면서 런타임 캐시를
    // `.next/standalone/.next/cache` 에 쓰는 중이라, 그 디렉터리에 대한 재귀 삭제는
    // 중간에 깨질 수 있다. 순서 자체가 계약이므로 소스 순서로 고정한다.
    // (행위 테스트로 잡으려면 "아직 로드됨" 폴링 15초를 매번 기다려야 해서 여기서 본다 —
    //  `preview-down-behavior.test.ts` 가 나머지 행위를 덮는다.)
    //
    // ⚠️ 반드시 **cmd_down 본문 안에서만** 센다. 파일 전체로 세면 같은 폴링 코드가 있는
    // cmd_up 의 줄이 먼저 잡혀서, cmd_down 안에서 삭제가 폴링 앞으로 올라가도 여전히
    // "뒤에 있다"는 답이 나온다(이 계약의 첫 판이 실제로 그랬고, 변이 검증에서 드러났다).
    const lines = activeLines(functionBody(src, "cmd_down"));
    const unloadIdx = lines.findIndex((l) => /unloaded=1;\s*break/.test(l));
    const markerRmIdx = lines.findIndex((l) => /\brm\s+-f\s+"\$PREVIEW_MARKER"/.test(l));
    const nextRmIdx = lines.findIndex((l) => /\brm\s+-[A-Za-z]*r[A-Za-z]*\s+"\$PREVIEW_CHECKOUT/.test(l));

    expect(unloadIdx, "언로드 폴링을 찾지 못했다 — 계약 기준을 갱신할 것").toBeGreaterThan(-1);
    expect(markerRmIdx, "마커 삭제를 찾지 못했다").toBeGreaterThan(-1);
    expect(nextRmIdx, "빌드 산출물 삭제를 찾지 못했다").toBeGreaterThan(-1);
    expect(markerRmIdx, "마커 삭제가 언로드 확인보다 앞에 있다").toBeGreaterThan(unloadIdx);
    expect(nextRmIdx, "산출물 재귀 삭제가 언로드 확인보다 앞에 있다 — 살아 있는 앱과 경합한다").toBeGreaterThan(unloadIdx);
  });

  it("삭제 대상 마커가 프로덕션 레인의 마커가 아니다", () => {
    // down 은 프리뷰 배포 마커도 지운다(지우지 않으면 다음 up 이 deploy.sh 의
    // "변경 없음" 경로로 빠져 빌드를 건너뛴다). 프로덕션 마커 파일명은
    // `deployed.sha` 로 프리뷰의 `deployed.preview.sha` 와 다르고, 부분문자열
    // 관계도 아니다 — 그 이름이 이 파일에 아예 없어야 오지우기가 원천 봉쇄된다.
    // (전역 부재이므로 줄바꿈 우회도 통하지 않는다.)
    const active = activeLines(src).join("\n");
    expect(active).toContain("deployed."); // 스캐너 고장 감지 — 마커 유도가 사라졌으면 이 계약도 갱신할 것
    expect(active).not.toContain("deployed.sha");
  });
});
