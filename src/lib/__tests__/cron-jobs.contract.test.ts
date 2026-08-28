import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_JOBS, KNOWN_JOB_KEYS } from "@/lib/cron-jobs";

/**
 * 크론 잡 목록 계약 — cron-jobs.ts가 레이더 표시·수동 실행 허용의 SSOT임을 강제한다.
 *
 * 배경: 표시 목록(KNOWN_JOBS)과 허용 목록(ALLOWED_JOBS)이 두 파일에 사본으로 존재하던
 * 시절, collect-qnas·analyze-voc 추가 PR이 레이더만 갱신해 수동 실행 버튼이 400
 * ("알 수 없는 jobKey")으로 죽는 드리프트가 실제로 났다. 이 테스트는
 *  C1. 레이더의 모든 행이 실제 크론 라우트를 가진다(버튼이 404/400으로 죽지 않는다)
 *  C2. 레이더의 모든 행이 **자기 레인의** 스케줄러에 등록돼 있다(안 도는 크론을 "매일 …"로
 *      보여 주는 레이더 거짓말 금지 — collect-reviews 일시중단과 같은 불변식).
 *      2026-08-04부터 **양방향**이다 — 공용 레인(lane:"vercel")은 스케줄러에 있어야 하고,
 *      lane:"local"(오너 맥 launchd)은 거기 **없어야** 한다. 후자를 안 막으면 로컬 레인으로
 *      옮긴 잡이 공용 스케줄러에서도 계속 발화해 이중 실행이 되고, 그쪽 실패가 러너의 성공
 *      기록을 덮어써 레이더가 매일 빨강이 된다(capture-stories 를 옮기며 실제로 걸린 위험).
 *      ⛔ 종전 서술 "스케줄 정본은 vercel.json crons"는 **SUPERSEDED**(2026-08-15) —
 *      정본은 `infra/selfhost/crontab` 이고 vercel.json 에는 crons 가 아예 없다(아래 주석).
 *  C3. 두 소비처가 사본이 아니라 SSOT를 import한다(드리프트 재발 차단)
 * 를 고정한다.
 *
 * 주의(앵커 함정): 파일이 비었거나 경로가 틀리면 "금지 문자열 없음"이 공허 통과한다 —
 * 각 파일에 존재해야 하는 앵커를 먼저 단언한다(음성 대조군).
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf-8");

/**
 * 스케줄 정본 = `infra/selfhost/crontab`(오너 맥). 2026-08-15 부터 `vercel.json` 에는
 * crons 키가 **없다** — 컷오버 이후에도 구 Vercel 배포가 같은 잡을 계속 발화해 자체호스팅과
 * 이중 실행되던 사고(07:00 자체호스팅 / 07:01 구 배포, 실측)로 제거했다. vercel.json 은
 * 배포마다 크론을 재등록하므로 파일에 남겨 두는 것 자체가 부활 장치였다. 롤백 시 되살릴
 * UTC 원본 표현식은 crontab 각 줄 위에 주석으로 병기돼 있다.
 *
 * crontab 은 맥 로컬 시간대(KST)로 돌므로 UTC 환산이 없다 — 분·시가 곧 레이더 표기다.
 */
const KST_DAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

type CronEntry = { minute: string; hour: string; dow: string };

const crontabSource = (): string => {
  const src = read("infra/selfhost/crontab");
  expect(src, "crontab 파일이 비었다(앵커 함정)").toContain("run-cron.sh");
  return src;
};

/** crontab 의 **활성**(주석이 아닌) 잡 줄을 key → 5필드로 파싱한다. */
const crontabByKey = (): Map<string, CronEntry> => {
  // 선두 `[0-9*]` 가 활성 줄 조건이다 — 주석 줄은 `#` 로 시작하므로 걸리지 않는다.
  const re = /^([0-9*]\S*)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+\S*run-cron\.sh\s+(\S+)/gm;
  const map = new Map<string, CronEntry>();
  for (const [, minute, hour, , , dow, key] of crontabSource().matchAll(re)) {
    map.set(key, { minute, hour, dow });
  }
  expect(map.size, "crontab 에서 활성 잡 줄을 하나도 파싱하지 못했다").toBeGreaterThan(0); // 음성 대조군
  return map;
};

/** crontab 5필드(KST) → 레이더 표기(cycle·timeKst) */
const toKstDisplay = (e: CronEntry): { cycle: string; timeKst: string } => {
  const h = Number(e.hour);
  const m = Number(e.minute);
  expect(Number.isInteger(h) && Number.isInteger(m), `단순 숫자 필드가 아닌 스케줄: ${e.minute} ${e.hour}`).toBe(true);
  const timeKst = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (e.dow === "*") return { cycle: "매일", timeKst };
  const dow = Number(e.dow) % 7;
  expect(Number.isInteger(dow), `요일 필드를 해석할 수 없음: ${e.dow}`).toBe(true);
  return { cycle: `매주 ${KST_DAYS[dow]}`, timeKst };
};

describe("C1 — 레이더의 모든 잡은 실제 크론 라우트를 가진다", () => {
  it("KNOWN_JOBS가 비어 있지 않다(음성 대조군)", () => {
    expect(KNOWN_JOBS.length).toBeGreaterThan(0);
    expect(KNOWN_JOB_KEYS.size).toBe(KNOWN_JOBS.length); // key 중복도 여기서 걸린다
  });

  for (const job of KNOWN_JOBS) {
    it(`${job.key}: src/app/api/cron/${job.key}/route.ts 존재`, () => {
      expect(existsSync(join(root, "src/app/api/cron", job.key, "route.ts"))).toBe(true);
    });
  }
});

describe("C2 — 로컬 레인 잡은 공용 스케줄러에 없다(이중 발화 금지)", () => {
  // 공용 레인(lane:"vercel")의 **존재** 쪽은 C6 가 소유한다 — 같은 단언을 두 곳에 두면
  // 한쪽만 고쳐지는 드리프트가 계약 자신에게 생긴다. 여기는 **부재** 쪽 전담이다.

  it("vercel.json 에는 crons 키가 아예 없다(부활 장치 제거 유지)", () => {
    const config = JSON.parse(read("vercel.json")) as Record<string, unknown>;
    expect(config.$schema, "vercel.json 앵커 없음(공허 통과 방지)").toBeDefined();
    expect(
      "crons" in config,
      "vercel.json 에 crons 가 되살아났다 — 구 Vercel 배포는 배포마다 크론을 재등록하므로, 롤백으로 그 배포가 살아나는 순간 자체호스팅 crontab 과 **모든 잡이 이중 발화**한다(2026-08-15 실측 사고: 07:00 자체호스팅 / 07:01 구 배포). 롤백 절차는 crontab 을 먼저 잠그는 것이지 이 파일을 되살리는 것이 아니다(rollback.sh Step 4).",
    ).toBe(false);
  });

  it("lane:'local' 잡은 crontab 에 **없다**", () => {
    const scheduled = crontabByKey();
    for (const job of KNOWN_JOBS.filter((j) => j.lane === "local")) {
      expect(
        scheduled.has(job.key),
        `${job.key} 는 로컬 레인(launchd)인데 crontab 에도 있다 — 같은 잡이 두 번 발화하고, 한쪽 실패가 다른 쪽의 성공 기록을 덮어써 레이더가 매일 빨강이 된다`,
      ).toBe(false);
    }
  });

  it("로컬 레인 잡은 러너 스크립트를 가진다(발화 주체가 실재해야 한다)", () => {
    // 레인만 바꾸고 러너가 없으면 그 잡은 **아무 데서도** 안 돈다 — vercel.json 에서 빠진
    // 채 조용히 죽는다. C1이 라우트 존재를 강제하듯, 로컬 레인은 러너 존재를 강제한다.
    for (const job of KNOWN_JOBS.filter((j) => j.lane === "local")) {
      expect(
        existsSync(join(root, `scripts/${job.key}-local.ts`)),
        `${job.key} 는 로컬 레인인데 scripts/${job.key}-local.ts 가 없다`,
      ).toBe(true);
    }
  });

  it("로컬 레인 러너는 실행 결과를 레이더에 기록한다(관측 상실 방지)", () => {
    // 러너가 recordSystemTaskRun 을 안 부르면 그 잡은 레이더에서 영원히 눈이 먼다 —
    // 서버에서 고친 무음 실패를 실행 위치만 바꿔 되사는 구조가 된다(2026-08-04).
    for (const job of KNOWN_JOBS.filter((j) => j.lane === "local")) {
      const src = read(`scripts/${job.key}-local.ts`);
      expect(src, `${job.key} 러너가 비어 있음(앵커 함정)`).toContain("main(");
      expect(
        src.includes("recordSystemTaskRun"),
        `scripts/${job.key}-local.ts 가 recordSystemTaskRun 을 부르지 않는다 — 레이더가 이 잡에 눈이 먼다`,
      ).toBe(true);
    }
  });

  it("로컬 레인 스케줄러는 실행 전 스스로 최신화한다(구코드 실행 방지)", () => {
    // 실사고 2026-08-04(설치 당일): plist 의 작업 디렉터리를 **여러 세션이 공유하는 메인
    // 레포**로 뒀는데, 설치 시점에 그 트리가 타 세션 브랜치에 체크아웃돼 있어 launchd 가
    // **직전 버전 러너**(상태 기록 코드가 없는)를 실행했다. 수집은 되는데 SystemTaskLog 에는
    // 아무것도 안 남는 관측 상실이 **실행 위치만 바꿔 재발**한 것이다.
    //
    // 요점: **release 가 최신이어도 실행되는 트리가 그걸 반영한다는 보장이 없다.** 배포와
    // 실행 트리는 서로 다른 축이고, 로컬 레인에서는 후자를 아무도 안 지킨다. 그래서 스케줄러
    // 자신이 실행 직전 origin/main 으로 갱신하게 하고, 그 단계를 여기서 고정한다.
    for (const job of KNOWN_JOBS.filter((j) => j.lane === "local")) {
      const plist = read(`scripts/launchd/kr.ygrd.wagcrm.${job.key}.plist`);
      expect(plist, "plist 앵커 없음(공허 통과 방지)").toContain("ProgramArguments");
      expect(
        plist.includes("--ff-only"),
        `${job.key} plist 에 자기 갱신(git merge --ff-only origin/main) 단계가 없다 — 실행 트리가 낡으면 배포된 수정이 조용히 무시된다`,
      ).toBe(true);
    }
  });
});

describe("C4 — 수동 폴백 워크플로의 ALL 목록에 유령 타깃이 없다", () => {
  // 실사고(2026-07-28): #101이 알림센터를 해체하며 notifications 크론 라우트를 지웠는데
  // 폴백 워크플로 ALL 목록에는 이름이 남아, "all" 수동 실행이 404로 실패했다(prod 실측).
  // C1~C3은 KNOWN_JOBS·vercel.json·소비처만 봐서 이 목록을 아무도 안 지키고 있었다.
  const WORKFLOW = ".github/workflows/scheduled-crons.yml";

  const allList = (): string[] => {
    const src = read(WORKFLOW);
    expect(src).toContain("ALL="); // 앵커(파일 구조 변경 시 공허 통과 방지)
    const m = /^\s*ALL="([^"]+)"/m.exec(src);
    expect(m, `${WORKFLOW}에서 ALL= 목록을 파싱하지 못했다`).not.toBeNull();
    return m![1].split(/\s+/).filter(Boolean);
  };

  it("ALL의 모든 타깃이 실제 크론 라우트를 가진다(404 유령 금지)", () => {
    const targets = allList();
    expect(targets.length).toBeGreaterThan(0); // 음성 대조군
    for (const t of targets) {
      expect(
        existsSync(join(root, "src/app/api/cron", t, "route.ts")),
        `ALL 목록의 "${t}" 라우트가 없다 — 수동 "all" 실행이 404로 실패한다(라우트 삭제 시 이 목록도 지울 것)`,
      ).toBe(true);
    }
  });

  it("ALL에 중복이 없다(같은 크론 이중 호출 = 부작용 이중 실행)", () => {
    const targets = allList();
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("일시중단 크론은 ALL에 없다(collect-reviews — 'all'이 조용히 되살리면 안 된다)", () => {
    // 스케줄 정본(crontab)에 없는 크론은 의도적 제외이므로 폴백 "all"도 되살리면 안 된다.
    const scheduled = crontabByKey();
    for (const t of allList()) {
      expect(
        scheduled.has(t),
        `ALL 목록의 "${t}"가 infra/selfhost/crontab 에 없다 — 일시중단분이면 목록에서 빼고, 정기 크론이면 crontab 에 추가할 것`,
      ).toBe(true);
    }
  });
});

describe("C5 — 레이더 표기(cycle·timeKst)가 스케줄러의 발화 시각과 일치한다", () => {
  // 실사고 계열(2026-07-30): 수집 크론을 주간→매일로 바꾸면서 스케줄러만 고치고
  // KNOWN_JOBS를 두면, 레이더가 "매주 월 12:00"이라고 표시하는데 실제로는 매일 도는
  // 상태가 된다. C2·C6는 "스케줄돼 있는가"만 보므로 이 드리프트를 잡지 못했다.
  // 예정 시각 문구는 오너가 "안 돌았다"를 판정하는 근거라 틀리면 곧 오진이다.

  // 로컬 레인은 crontab 에 스케줄이 없다(C2가 없어야 함을 강제한다) — 대조 대상이
  // 아니라 제외한다. 그 레인의 표기 정합은 러너 스케줄러(launchd plist)가 근거이고,
  // 아래 별도 it 이 고정한다.
  for (const job of KNOWN_JOBS.filter((j) => j.lane === "vercel")) {
    it(`${job.key}: 레이더 "${job.cycle} ${job.timeKst}"가 크론식과 맞는다`, () => {
      const entry = crontabByKey().get(job.key);
      expect(entry, `${job.key} 스케줄 없음`).toBeDefined();
      expect(toKstDisplay(entry!)).toEqual({ cycle: job.cycle, timeKst: job.timeKst });
    });
  }

  for (const job of KNOWN_JOBS.filter((j) => j.lane === "local")) {
    it(`${job.key}: 레이더 표기가 launchd plist 의 발화 시각과 맞는다`, () => {
      const plist = read(`scripts/launchd/kr.ygrd.wagcrm.${job.key}.plist`);
      const [hh, mm] = job.timeKst.split(":").map(Number);
      // plist 는 로컬(맥) 시각 기준이라 KST 표기와 그대로 대응한다(UTC 변환 없음).
      expect(plist, "plist 앵커 없음").toContain("StartCalendarInterval");
      expect(plist).toMatch(new RegExp(`<key>Hour</key>\\s*<integer>${hh}</integer>`));
      expect(plist).toMatch(new RegExp(`<key>Minute</key>\\s*<integer>${mm}</integer>`));
      expect(job.cycle, "launchd StartCalendarInterval 은 매일 발화다").toBe("매일");
    });
  }

  // 셀러 자동수집의 설계 의도 고정 — 되돌리면 오너 체감 버그가 그대로 재발한다.
  it("셀러 수집 크론은 매일 발화한다(주기 판정은 셀러별 7일 cutoff가 한다)", () => {
    const schedules = crontabByKey();
    for (const key of ["collect-instagram", "collect-youtube"]) {
      const dow = schedules.get(key)?.dow;
      expect(
        dow,
        `${key}가 주 1회로 돌아갔다 — 주간 발화 × 7일 cutoff 조합은 실효 주기를 14일로 늘리고(월요일에 6일밖에 안 지난 셀러는 스킵), 실패·데드라인 이월분을 일주일 지연시킨다. 재수집 판정은 collect-cycle의 cutoff에 맡기고 크론은 매일 둘 것.`,
      ).toBe("*");
    }
  });
});

describe("C6 — 프로덕션 스케줄러(셀프호스트 crontab)에 등록돼 있다", () => {
  // ⚠️ **2026-08-13 컷오버 이후 실제로 크론을 발화하는 것은 `infra/selfhost/crontab` 이다.**
  // 새 크론을 KNOWN_JOBS 에만 넣으면 **레이더에 예정 시각이 떠 있는데 프로덕션에서는 한 번도
  // 발화하지 않는다** — "레이더 거짓말"이 레인이 바뀌면서 반대쪽 파일에 그대로 재현되는
  // 구조였다(감사 크론을 추가하며 실측으로 드러났다).
  //
  // 개수는 세지 않는다 — 프리뷰 레인 줄(preview-db.sh)처럼 앱 크론이 아닌 항목이 섞여
  // 있고, 고정 숫자를 심으면 크론이 늘 때마다 이 테스트가 정상 상태를 실패로 만든다.
  // 시각 정합(timeKst·cycle)은 C5 가 소유한다 — 여기는 **존재** 전담이다.
  it("lane:'vercel' 잡은 crontab 에 run-cron.sh <key> 로 등록돼 있다", () => {
    const scheduled = crontabByKey();
    const sharedJobs = KNOWN_JOBS.filter((j) => j.lane === "vercel");
    expect(sharedJobs.length, "공용 레인 잡이 하나도 없음(음성 대조군)").toBeGreaterThan(0);
    for (const job of sharedJobs) {
      expect(
        scheduled.has(job.key),
        `${job.key} 가 infra/selfhost/crontab 에 활성 줄로 없다 — 프로덕션(셀프호스트)에서는 발화하지 않는데 레이더는 예정 시각을 표시한다(일시중단이면 collect-reviews 처럼 KNOWN_JOBS 에서도 빼고, 로컬 레인이면 lane:"local" 로 선언한다).`,
      ).toBe(true);
    }
  });
});

describe("C3 — 소비처는 사본이 아니라 SSOT를 import한다", () => {
  it("cron-run 라우트: KNOWN_JOB_KEYS 파생, 잡 키 리터럴 목록 없음", () => {
    const src = read("src/app/api/system/cron-run/route.ts");
    expect(src).toContain("ALLOWED_JOBS"); // 앵커
    expect(src).toContain('from "@/lib/cron-jobs"');
    expect(src).toContain("KNOWN_JOB_KEYS");
    // 사본 부활 감지 — 허용 목록을 다시 리터럴로 들고 있으면 잡 키 문자열이 라우트에 나타난다.
    for (const job of KNOWN_JOBS) {
      expect(src.includes(`"${job.key}"`), `cron-run 라우트에 "${job.key}" 리터럴 발견 — 허용 목록 사본 부활(SSOT 위반)`).toBe(false);
    }
  });

  it("레이더 카드: KNOWN_JOBS를 import하고 로컬 사본이 없다", () => {
    const src = read("src/components/crm/system-radar-card.tsx");
    expect(src).toContain("KNOWN_JOBS"); // 앵커
    expect(src).toContain('from "@/lib/cron-jobs"');
    expect(src.includes("const KNOWN_JOBS")).toBe(false);
  });
});
