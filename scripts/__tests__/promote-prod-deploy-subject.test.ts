import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * promote-prod.sh 의 배포 커밋 subject 조립 파이프라인을 고정한다.
 *
 * 왜 필요한가(실사고 2026-08-12): 배포 커밋 subject 는 배치에 담긴 `#NN` 프리픽스를
 * 모아 만든다 —
 *
 *   NUMS=$(git log --reverse --format=%s "$RANGE" | grep -oE '^#[0-9]+' | tr -d '#' | tr '\n' '.' | sed 's/\.$//')
 *
 * 스크립트는 `set -euo pipefail` 아래서 돈다. 범위 안의 커밋 제목에 `#NN` 프리픽스가
 * **하나도** 없으면 `grep` 이 매치 0건으로 exit 1 을 내고, `pipefail` 이 그 1을 파이프라인
 * 전체의 종료코드로 승격시킨다 — `NUMS=$(...)` 대입문 자체가 실패한 것으로 취급되어
 * `set -e` 가 **그 줄에서 스크립트를 죽인다**. 몇 줄 뒤(262행)에 있는 빈 값 폴백
 * (`SUBJECT="deploy <sha>"`)은 존재하지만 거기 도달하지 못한다.
 *
 * 실제로 이렇게 터졌다: squash 머지 직전 PR 제목 편집이 반영되지 않아 `#NN` 프리픽스
 * 없는 머지 커밋이 main 에 들어갔다. 실패는 **머지 시점이 아니라 승격 시점**에, 마지막
 * 출력 줄로부터 몇 단계 뒤에서, 아무 에러 메시지도 없는 맨 `exit 1`로 나타났다 —
 * `bash -x` 없이는 원인을 알 수 없었다. 처방은 파이프라인 끝에 `|| true` 를 붙여
 * "실패해도 계속 진행하고, 그다음 줄의 빈 값 폴백이 처리하게 둔다"를 명시하는 것이다.
 *
 * ## 이 테스트가 다루는 범위
 *
 * `--check`·`--dry-run` 은 이 파이프라인에 도달하기 전에 return/exit 한다(각각 236·241행
 * 이전). 이 코드에 도달하는 유일한 경로는 확인 프롬프트를 넘긴 실행 모드(`--yes` 또는
 * 대화형 `y`)뿐이고, 그 경로는 결국 `git push`(285행)까지 간다 — 그래서 여기서는
 * `promote-prod-check.test.ts` 의 `setupRepo` 와 같은 수법으로 **로컬 임시 bare 저장소**를
 * `REMOTE` 로 위장시켜, push 가 실제 네트워크·real 리모트에 전혀 닿지 않게 한다(파일시스템
 * 안에서만 오가는 `git push`). `PROMOTE_NO_POLL=1` 로 push 직후 `poll_deployment`(gh api ·
 * Vercel 폴링)를 건너뛰어 배포 플랫폼에도 닿지 않는다 — 스크립트 287~290행이 이 분기를
 * 명시적으로 지원한다. 즉 스크립트를 **끝까지 실제로** 돌리되, 부작용은 전부 임시 디렉터리
 * 안에 갇힌다.
 */

const SCRIPT = path.resolve(__dirname, "..", "promote-prod.sh");

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 실패: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * `promote-prod-check.test.ts` 의 `setupRepo` 와 동일한 위장 수법 — 스크립트의 REMOTE
 * 탐지는 push URL 이 `indexzigu/wagcrm_git` 으로 끝나는지만 보므로, 그 이름의 로컬 bare
 * 저장소를 리모트로 붙인다. base 커밋을 main·release 양쪽에 밀어 release 가 존재하게
 * 만들고(그래야 LANE_SHA 가 잡혀 문제의 파이프라인까지 도달한다), `pendingSubjects`
 * 만큼 커밋을 얹어 main 에만 민다 — 그 커밋들의 subject 가 곧 grep 대상이다.
 */
function setupRepo(pendingSubjects: string[]) {
  const base = mkdtempSync(path.join(tmpdir(), "promote-nums-"));
  const upstream = path.join(base, "indexzigu", "wagcrm_git");
  mkdirSync(upstream, { recursive: true });
  git(base, ["init", "-q", "--bare", upstream]);

  const work = path.join(base, "work");
  mkdirSync(work);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "test@example.local"]);
  git(work, ["config", "user.name", "test"]);
  git(work, ["config", "commit.gpgsign", "false"]);

  let seq = 0;
  const commit = (msg: string) => {
    seq += 1;
    writeFileSync(path.join(work, "f.txt"), `${msg}-${seq}`);
    git(work, ["add", "f.txt"]);
    git(work, ["commit", "-q", "-m", msg]);
    return git(work, ["rev-parse", "HEAD"]);
  };

  const baseSha = commit("base");
  git(work, ["remote", "add", "origin", upstream]);
  git(work, ["push", "-q", "origin", `${baseSha}:refs/heads/main`, `${baseSha}:refs/heads/release`]);

  for (const subject of pendingSubjects) commit(subject);
  git(work, ["push", "-q", "origin", "main:refs/heads/main"]);

  return work;
}

/**
 * 실제 promote-prod.sh 를 `--yes` 로 끝까지 돌린다. push 는 위 `setupRepo` 가 만든 로컬
 * bare 저장소로만 가고(실제 리모트 아님), `PROMOTE_NO_POLL=1` 이 배포 플랫폼 폴링을
 * 건너뛴다 — `gh`·Vercel 어느 쪽에도 닿지 않는다.
 */
function runPromote(work: string) {
  const clean = { ...process.env };
  delete clean.PROMOTE_MAX_PENDING;
  delete clean.PROMOTE_MAX_AGE_HOURS;
  const r = spawnSync("bash", [SCRIPT, "--yes"], {
    cwd: work,
    encoding: "utf8",
    env: { ...clean, PROMOTE_NO_POLL: "1" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("promote-prod.sh — 배포 커밋 subject 조립 (#NN 프리픽스 grep)", () => {
  it("범위 안 커밋에 #NN 프리픽스가 하나도 없어도 죽지 않고 sha 폴백을 쓴다", () => {
    // 이 케이스가 바로 실사고 재현이다: `|| true` 가 없으면 grep 이 매치 0건으로 exit 1,
    // pipefail 이 그걸 NUMS= 대입의 실패로 만들어 set -e 가 여기서 스크립트를 죽인다.
    // 그러면 아래 "배포 커밋:" 줄이 전혀 출력되지 않고 exit 코드도 0이 아니다.
    const work = setupRepo(["fix layout bug", "update internal docs"]);
    const r = runPromote(work);

    expect(r.status, `스크립트가 살아남지 못했다:\n${r.out}`).toBe(0);
    expect(r.out).toContain("배포 커밋:");
    // 폴백 형태: "deploy <7자리 이상 sha>" — "deploy #" 형태가 아니다.
    expect(r.out).toMatch(/\[deploy [0-9a-f]{7,40}\]/);
    expect(r.out).not.toContain("deploy #");
    expect(r.out).toContain("push 완료");
  });

  it("범위 안 커밋에 #NN 프리픽스가 있으면 여전히 번호 나열 형태를 쓴다 (회귀 방지)", () => {
    // 양성 케이스 — `|| true` 를 붙였다고 정상 케이스의 동작이 바뀌면 안 된다.
    const work = setupRepo(["#42 fix layout bug", "#43 update internal docs"]);
    const r = runPromote(work);

    expect(r.status, `스크립트가 살아남지 못했다:\n${r.out}`).toBe(0);
    expect(r.out).toContain("배포 커밋:");
    expect(r.out).toContain("[deploy #42.43]");
  });
});
