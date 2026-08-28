// 테스트 스텁의 **실행파일 재생성 금지** 계약 — 선재 flaky 의 재발 방지.
//
// ## 무엇을 막는가 (2026-08-04 실사고 → PR #273 처방)
//
// macOS 는 **새로 만들어진 실행파일의 첫 execve** 마다 보안 검사를 돌린다. 실측(Darwin 25):
// 갓 만든 실행파일 첫 실행 400~700ms · 같은 파일 재실행 ~23ms · `bash <파일>` 로 데이터로
// 읽기 ~6ms. 종전 스텁은 테스트마다 임시 디렉터리에 `gh` 를 새로 쓰고 `chmod +x` 했으므로
// 이 요금을 테스트당 1~2회 물었고, 머신 부하가 높으면 vitest 기본 `testTimeout`(5s)을 넘겨
// **매번 다른 테스트가 4회 중 1회꼴로** 실패했다(실패 지속시간이 전부 5.0~5.8s 에 몰렸다).
//
// 처방은 `helpers/gh-stub.ts` 의 **내용 고정 래퍼 하나 + 데이터 본문**이다. 실제로 execve
// 되는 파일이 하나뿐이라 머신당 사실상 1회만 검사받는다.
//
// ## 왜 계약이 필요한가
//
// 처방이 **규약**이라 새 테스트가 모르고 되돌리기 쉽다 — 임시 디렉터리에 스텁을 쓰고
// `chmod 0o755` 하는 것은 자연스러운 코드이고, 되돌려도 **테스트는 통과한다**(느려질 뿐).
// 증상이 "가끔, 다른 파일에서" 나타나므로 사람이 원인에 도달하기까지 오래 걸린다.
// 2026-08-05 재검증 기준선: 코어 전량 점유 부하에서 개별 테스트 최악 2.4s / 한도 5.0s.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  GH_STUB_WRAPPER_BODY,
  GH_STUB_WRAPPER_DIR_NAME,
  STAT_STUB_WRAPPER_BODY,
  STAT_STUB_WRAPPER_DIR_NAME,
} from "./helpers/gh-stub";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "scripts"), join(ROOT, "src"), join(ROOT, "e2e")];

/**
 * 실행 권한을 부여하는 표현들. PATH 로 잡혀 execve 되려면 실행 비트가 있어야 하므로,
 * 이 표현들이 곧 "새 실행파일을 만든다"의 실질적 관문이다.
 */
const EXECUTABLE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /chmodSync\s*\(/, what: "chmodSync" },
  { re: /\bchmod\s*\(/, what: "fs.chmod" },
  { re: /mode:\s*0o7/, what: "writeFileSync({ mode: 0o7xx })" },
  { re: /["'`]chmod["'`]/, what: "spawn('chmod')" },
  { re: /\+x\b/, what: "chmod +x" },
];

/**
 * 예외는 둘뿐이고 성격이 다르다.
 *
 * ⚠️ 여기에 **처방 계열** 파일을 추가하는 것은 flaky 를 되살리는 결정이다. 추가 전에 위
 * 실측치를 다시 읽고, 정말 execve 되어야 하는지(= `bash <파일>` 로 데이터 실행이
 * 불가능한지) 확인할 것.
 */
const EXEMPT: Array<{ file: string; why: string }> = [
  {
    file: "scripts/__tests__/helpers/gh-stub.ts",
    why: "처방 자체 — 내용 고정 래퍼 하나만 만든다(머신당 사실상 1회 검사)",
  },
  {
    file: "scripts/__tests__/gh-stub-guard.contract.test.ts",
    why: "이 스캐너 — 탐지 패턴을 정규식 리터럴로 들고 있어 자기 자신에 걸린다",
  },
];
const EXEMPT_FILES = EXEMPT.map((e) => e.file);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // e2e 등 없을 수 있는 경로
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(full) || /__tests__/.test(full)) out.push(full);
  }
  return out;
}

describe("테스트가 실행파일 스텁을 새로 만들지 않는다", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d));

  it("스캔 대상 테스트 파일을 실제로 찾는다 (스캐너 고장 감지)", () => {
    expect(files.length).toBeGreaterThan(50);
    // 예외 파일이 스캔 범위 안에 실재해야 예외가 의미를 갖는다.
    const rels = files.map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"));
    for (const exempt of EXEMPT_FILES) expect(rels).toContain(exempt);
  });

  it("실행 권한을 부여하는 테스트 파일이 없다 (예외 목록 제외)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      if (EXEMPT_FILES.includes(rel)) continue;
      const src = readFileSync(file, "utf8");
      const hits = EXECUTABLE_PATTERNS.filter((p) => p.re.test(src)).map((p) => p.what);
      if (hits.length > 0) offenders.push(`${rel} → ${hits.join(", ")}`);
    }
    expect(
      offenders,
      "테스트가 실행파일을 새로 만들면 macOS 첫-execve 보안 검사(400~700ms)를 매번 물어 " +
        "부하 시 5초 타임아웃으로 번진다. `helpers/gh-stub.ts` 의 writeGhStub/ghStubEnv 를 " +
        "쓰거나(고정 래퍼 재사용), 실행 대신 `bash <파일>` 로 데이터로 읽을 것.",
    ).toEqual([]);
  });
});

describe("고정 래퍼는 본문과 버전이 한 쌍으로 움직인다", () => {
  // 🪤 본문만 고치고 디렉터리 버전을 안 올리면 머신에 남은 **구 래퍼가 계속 쓰인다** —
  // `ensureWrapper` 가 내용 불일치 시 덮어쓰긴 하지만, 병렬 파일 러너가 서로 다른 본문을
  // 번갈아 쓰면 매 실행이 "새 파일"이 되어 검사 요금이 되살아난다.
  it("본문이 바뀌면 이 계약이 실패해 버전 승급을 강제한다", () => {
    expect(GH_STUB_WRAPPER_DIR_NAME).toBe("wagcrm-gh-stub-v1");
    expect(GH_STUB_WRAPPER_BODY).toBe('#!/usr/bin/env bash\nexec bash "$GH_STUB_IMPL" "$@"\n');
  });

  it("래퍼는 스텁 본문을 **데이터로** 실행한다 (실행파일을 늘리지 않는다)", () => {
    expect(GH_STUB_WRAPPER_BODY).toContain('bash "$GH_STUB_IMPL"');
  });

  // stat 레인도 같은 함정을 진다 — 래퍼가 하나 늘었으니 고정도 함께 는다.
  // (버전 디렉터리를 gh 와 갈라 둬서 한쪽 본문 변경이 다른 쪽 래퍼를 무효화하지 않는다.)
  it("stat 래퍼도 본문과 버전이 한 쌍으로 움직인다", () => {
    expect(STAT_STUB_WRAPPER_DIR_NAME).toBe("wagcrm-stat-stub-v1");
    expect(STAT_STUB_WRAPPER_BODY).toBe('#!/usr/bin/env bash\nexec bash "$STAT_STUB_IMPL" "$@"\n');
  });

  it("stat 래퍼도 스텁 본문을 **데이터로** 실행한다", () => {
    expect(STAT_STUB_WRAPPER_BODY).toContain('bash "$STAT_STUB_IMPL"');
  });
});
