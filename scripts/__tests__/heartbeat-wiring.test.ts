import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SILENCE_AFTER_MIN, SILENCE_MIN_OBS, TICK_MIN,
  initialState, onBeat, onTick, type BeatState,
} from "../../wag-heartbeat/src/decide";
import {
  handleBeat, handleTick, parseState,
  RESEND_MIN_INTERVAL_H, BEAT_SAVE_DEBOUNCE_MS,
  type StateStore, type StoredState,
} from "../../wag-heartbeat/src/apply";

/**
 * 이 계약이 이 설계의 중심이다 — 생존 신고의 **발신 주체가 메뉴바 앱**이어야 한다.
 * launchd·crontab 으로 옮기면 앱이 죽어도 신호가 계속 흘러, 이번에 닫으려는 구멍
 * (앱이 죽으면 전 체계가 조용해진다)이 그대로 살아남는다. 사람 눈으로는 "어차피
 * 같은 맥에서 도는 것"으로 보여 옮기기 쉬운 자리라 기계로 못 박는다.
 */
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "infra", "selfhost", "heartbeat.sh");
const SWIFT_DIR = path.join(ROOT, "infra", "selfhost", "menubar", "Sources");
const tmp = mkdtempSync(path.join(tmpdir(), "heartbeat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(opts: { url?: string; token?: string } = {}): { calls: string; code: number } {
  const home = mkdtempSync(path.join(tmp, "home-"));
  mkdirSync(path.join(home, "selfhost", "logs"), { recursive: true });
  const calls = path.join(home, "calls.log");
  const curlImpl = path.join(home, "curl.impl");
  writeFileSync(curlImpl, `printf '%s\\n' "$*" >> "${calls}"\n`);
  const envFile = path.join(home, "creds.env");
  writeFileSync(
    envFile,
    [
      opts.url === undefined ? 'HEARTBEAT_URL="https://beat.example/beat"' : opts.url ? `HEARTBEAT_URL="${opts.url}"` : "",
      opts.token === undefined ? 'HEARTBEAT_TOKEN="tok"' : opts.token ? `HEARTBEAT_TOKEN="${opts.token}"` : "",
    ].filter(Boolean).join("\n") + "\n",
  );
  let code = 0;
  try {
    execFileSync("bash", [SCRIPT], {
      env: { ...process.env, HOME: home, HEARTBEAT_CURL_CMD: `bash ${curlImpl}`, HEARTBEAT_ENV_FILE: envFile },
      encoding: "utf8",
    });
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  return { calls, code };
}

const calls = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

describe("heartbeat.sh", () => {
  it("설정이 있으면 신고를 한 번 보낸다", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(calls(r.calls)).toContain("https://beat.example/beat");
    expect(calls(r.calls)).toContain("Bearer tok");
  });

  it("URL 이 없으면 조용히 종료한다", () => {
    const r = run({ url: "" });
    expect(r.code).toBe(0);
    expect(calls(r.calls)).toBe("");
  });

  it("토큰이 없으면 보내지 않는다(무인증 신고 금지)", () => {
    // /beat 가 무인증이면 누구나 가짜 생존 신호를 넣어 침묵 판정을 영원히 막을 수 있다.
    const r = run({ token: "" });
    expect(calls(r.calls)).toBe("");
  });

  /** 주석은 걷어내고 본다 — 금지 대상은 **실행되는 코드**다. 주석까지 스캔하면 "왜
   *  상태를 싣지 않는가"를 설명하는 주석이 판정 스크립트를 이름으로 부르지 못하게
   *  되고, 그러면 함정을 설명하는 문장이 그 함정의 위반으로 잡힌다(이 파일 아래
   *  "파괴적 명령이 없다" 형제 단언이 이미 같은 방식을 쓴다). */
  const activeLines = (src: string): string =>
    src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("상태 전문을 싣지 않는다(판정 SSOT 유출 금지)", () => {
    const active = activeLines(readFileSync(SCRIPT, "utf8"));
    expect(active).not.toContain("status.sh");
    expect(active).not.toMatch(/\bitems\b/);
  });

  it("주석 제거기가 실제로 동작한다(공허 통과 방지)", () => {
    // 양성/음성 프로브 — 스트리퍼가 고장 나 전부를 지우거나 아무것도 안 지우면 위
    // 단언이 조용히 무의미해진다.
    expect(activeLines("# status.sh 를 부르지 않는다\ncurl -X POST x\n")).not.toContain("status.sh");
    expect(activeLines("# 주석\nstatus.sh\n")).toContain("status.sh");
  });

  it("파괴적 명령이 없다", () => {
    const active = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(active).not.toMatch(/\bdocker\s+(rm|stop|kill)\b/);
    expect(active).not.toMatch(/\blaunchctl\s+(bootout|bootstrap)\b/);
    expect(active).not.toMatch(/\brm\s+-rf\b/);
  });
});

describe("생존 신고 발신 주체 계약", () => {
  const swift = readdirSync(SWIFT_DIR)
    .filter((f) => f.endsWith(".swift"))
    .map((f) => readFileSync(path.join(SWIFT_DIR, f), "utf8"))
    .join("\n");

  it("메뉴바 앱이 heartbeat.sh 를 부른다", () => {
    expect(swift).toContain("heartbeat.sh");
  });

  it("full 폴링에서만 부른다(fast 30초에 태우지 않는다)", () => {
    expect(swift).toMatch(/if\s+!fast\s*\{[^}]*heartbeatScript/);
  });

  it("crontab 에 없다", () => {
    const crontab = readFileSync(path.join(ROOT, "infra", "selfhost", "crontab"), "utf8");
    expect(crontab).not.toContain("heartbeat.sh");
  });

  it("launchd plist 어디에도 없다", () => {
    const dir = path.join(ROOT, "infra", "selfhost", "launchd");
    const plists = readdirSync(dir).filter((f) => f.endsWith(".plist"));
    expect(plists.length).toBeGreaterThanOrEqual(3); // 스캐너 고장 감지
    for (const f of plists)
      expect(readFileSync(path.join(dir, f), "utf8"), f).not.toContain("heartbeat.sh");
  });
});

describe("dead-man 판정", () => {
  const MIN = 60_000;
  const now = 1_000_000_000_000; // 고정 기준점 — 시스템 시각을 쓰지 않는다(P9)
  const stateWithBeat = (agoMin: number, extra: Partial<BeatState> = {}): BeatState => ({
    lastBeatMs: now - agoMin * MIN,
    missStreak: 0,
    alerted: false,
    ...extra,
  });

  it("첫 tick 은 알리지 않고 기준점만 잡는다", () => {
    // 배포 직후 맥이 아직 안 붙었을 때 곧바로 울리면 안 된다.
    const d = onTick(initialState(), now);
    expect(d.notice).toBeNull();
    expect(d.next.lastBeatMs).toBe(now);
  });

  it("경과는 넘었지만 관측 횟수가 모자라면 알리지 않는다", () => {
    const d = onTick(stateWithBeat(SILENCE_AFTER_MIN + 1, { missStreak: SILENCE_MIN_OBS - 2 }), now);
    expect(d.notice).toBeNull();
    expect(d.next.missStreak).toBe(SILENCE_MIN_OBS - 1);
  });

  it("관측 횟수는 넘었지만 경과가 모자라면 알리지 않는다", () => {
    const d = onTick(stateWithBeat(SILENCE_AFTER_MIN - 1, { missStreak: SILENCE_MIN_OBS + 5 }), now);
    expect(d.notice).toBeNull();
  });

  it("둘 다 넘으면 침묵을 1회 알린다", () => {
    const d = onTick(stateWithBeat(SILENCE_AFTER_MIN + 1, { missStreak: SILENCE_MIN_OBS - 1 }), now);
    expect(d.notice).toEqual({ kind: "silence", minutes: SILENCE_AFTER_MIN + 1 });
    expect(d.next.alerted).toBe(true);
  });

  it("이미 알렸으면 다시 알리지 않는다", () => {
    const d = onTick(stateWithBeat(120, { missStreak: 50, alerted: true }), now);
    expect(d.notice).toBeNull();
  });

  it("신고가 들어오면 연속이 끊긴다", () => {
    const d = onBeat(stateWithBeat(40, { missStreak: 5 }), now);
    expect(d.next.missStreak).toBe(0);
    expect(d.next.lastBeatMs).toBe(now);
    expect(d.notice).toBeNull();
  });

  it("알린 뒤 신고가 돌아오면 복구를 1회 알리고 재무장한다", () => {
    const d = onBeat(stateWithBeat(47, { missStreak: 9, alerted: true }), now);
    expect(d.notice).toEqual({ kind: "recovered", minutes: 47 });
    expect(d.next.alerted).toBe(false);
  });

  it("정상 폴링 중에는 연속이 쌓이지 않는다", () => {
    // 신고 간격(5분)보다 짧게 지난 tick 은 미도착이 아니다.
    const d = onTick(stateWithBeat(TICK_MIN - 1, { missStreak: 3 }), now);
    expect(d.next.missStreak).toBe(0);
  });

  it("시계 역행(미래 신고)에 거짓 빨강을 내지 않는다", () => {
    const d = onTick({ lastBeatMs: now + 10 * MIN, missStreak: 0, alerted: false }, now);
    expect(d.notice).toBeNull();
  });

  it("문턱 정합 — 경과 문턱이 신고 간격 × 최소 관측수보다 크지 않다", () => {
    // 크면 경과가 실질 게이트이고 횟수는 하한이다(설계 의도). 반대가 되면 폴링을 몇 번
    // 놓친 정상 상황에서 영영 승격되지 않는다.
    expect(TICK_MIN * SILENCE_MIN_OBS).toBeLessThanOrEqual(SILENCE_AFTER_MIN);
  });
});

describe("발송 실패가 통지 상태를 오염시키지 않는다", () => {
  const MIN = 60_000;
  const now = 1_000_000_000_000; // 고정 기준점 — 시스템 시각을 쓰지 않는다(P9)

  /** 실제 KV 대신 쓰는 인메모리 저장소 — get/put 만 흉내 낸다. */
  function fakeStore(initialState: BeatState | null): StateStore & { saved: () => BeatState | null } {
    let raw: string | null = initialState ? JSON.stringify(initialState) : null;
    return {
      get: async () => raw,
      put: async (value: string) => {
        raw = value;
      },
      saved: () => (raw ? parseState(raw) : null),
    };
  }

  const silenceReadyState = (): BeatState => ({
    // 침묵 문턱(경과·관측 횟수)을 둘 다 넘긴 직전 상태 — 다음 tick 에서 반드시 notice 가 난다.
    lastBeatMs: now - (SILENCE_AFTER_MIN + 1) * MIN,
    missStreak: SILENCE_MIN_OBS - 1,
    alerted: false,
  });

  it("침묵 판정 + 발송 성공 → 저장된 상태의 alerted 가 true 다", async () => {
    const store = fakeStore(silenceReadyState());
    await handleTick(store, async () => true, now);
    expect(store.saved()?.alerted).toBe(true);
  });

  it("침묵 판정 + 발송 실패 → 저장된 상태의 alerted 가 true 가 아니다(다음 tick 재시도)", async () => {
    const store = fakeStore(silenceReadyState());
    await handleTick(store, async () => false, now);
    expect(store.saved()?.alerted).toBe(false);
  });

  it("침묵 판정 + 발송기가 예외를 던짐 → alerted 가 true 가 아니다(예외가 밖으로 새지 않는다)", async () => {
    const store = fakeStore(silenceReadyState());
    await expect(
      handleTick(store, async () => { throw new Error("network down"); }, now),
    ).resolves.toBeUndefined();
    expect(store.saved()?.alerted).toBe(false);
  });

  it("발송 실패해도 missStreak·lastBeatMs 갱신은 저장된다", async () => {
    const initial = silenceReadyState();
    const store = fakeStore(initial);
    await handleTick(store, async () => false, now);
    const saved = store.saved();
    expect(saved?.lastBeatMs).toBe(initial.lastBeatMs); // 관측 사실 — 미도착이라 불변
    expect(saved?.missStreak).toBe(initial.missStreak + 1); // 관측 사실 — 발송과 무관하게 누적
  });

  it("복구 통지 발송 실패 → alerted 가 true 로 유지돼 다음 신고에 다시 복구를 알린다", async () => {
    const store = fakeStore({ lastBeatMs: now - 47 * MIN, missStreak: 9, alerted: true });
    await handleBeat(store, async () => false, now);
    const saved = store.saved();
    expect(saved?.alerted).toBe(true); // 발송 실패 → 복구 통지 미완료로 남겨 재시도되게 한다
    expect(saved?.lastBeatMs).toBe(now); // 신고 자체는 실제로 도착한 관측 사실
  });
});

/**
 * C2 회귀 — Worker 절대 재발송 하한.
 *
 * 맥의 `alert-sent.tsv`(디스크 하한)에 대응하는 것이 없어, "발송 성공 시에만
 * alerted 저장"이라는 불변식과 맞물리면 KV `put()` 이 거부되는 순간(무료 티어
 * 한도 소진·일시 장애·rate limit) alerted 가 영영 안 붙어 5분마다 같은 침묵
 * 알림이 재발송된다. `lastNoticeMs` 는 이 실패를 alerted 와 **독립적으로** 막는
 * 계층이다 — 그래서 아래 첫 테스트는 alerted 저장이 실패한 것처럼 구성한 상태
 * (alerted=false 인데 lastNoticeMs 는 최근)에서도 하한이 걸리는지를 직접 본다.
 */
describe("C2 — 재발송 절대 하한(lastNoticeMs, alerted 와 독립)", () => {
  const MIN = 60_000;
  const now = 1_000_000_000_000; // 고정 기준점(P9)

  function fakeStore(initial: StoredState): StateStore & { saved: () => StoredState | null; putCount: number } {
    let raw: string | null = JSON.stringify(initial);
    const wrapper = {
      putCount: 0,
      get: async () => raw,
      put: async (value: string) => {
        wrapper.putCount += 1;
        raw = value;
      },
      saved: () => (raw ? parseState(raw) : null),
    };
    return wrapper;
  }

  /** 침묵 문턱(경과·관측 횟수)을 둘 다 넘긴 직전 상태 — 다음 tick 에서 반드시 notice 를 만든다. */
  const silenceReadyState = (extra: Partial<StoredState> = {}): StoredState => ({
    lastBeatMs: now - (SILENCE_AFTER_MIN + 1) * MIN,
    missStreak: SILENCE_MIN_OBS - 1,
    alerted: false,
    lastNoticeMs: null,
    ...extra,
  });

  it("하한 안이면 alerted 저장이 실패한 상태(alerted=false)에서도 재발송하지 않는다(C2 핵심 회귀)", async () => {
    // alerted=false 는 "직전 put 이 실패해 통지 플래그가 못 붙었다"를 흉내 낸 것이다.
    // lastNoticeMs 만은(별도 클레임 put 이 살아남아) 최근으로 남아 있다고 가정한다.
    const store = fakeStore(silenceReadyState({ lastNoticeMs: now - 10 * MIN }));
    let sendCalls = 0;
    await handleTick(store, async () => { sendCalls += 1; return true; }, now);
    expect(sendCalls).toBe(0);
    expect(store.saved()?.alerted).toBe(false); // 하한이 풀리면 다시 판정되도록 되돌린 값 그대로
  });

  it("하한 경계(6시간-1분)에서는 여전히 막는다", async () => {
    const store = fakeStore(
      silenceReadyState({ lastNoticeMs: now - (RESEND_MIN_INTERVAL_H * 60 - 1) * MIN }),
    );
    let sendCalls = 0;
    await handleTick(store, async () => { sendCalls += 1; return true; }, now);
    expect(sendCalls).toBe(0);
  });

  it("하한 밖(6시간+1분 전)이면 다시 나간다", async () => {
    const store = fakeStore(
      silenceReadyState({ lastNoticeMs: now - (RESEND_MIN_INTERVAL_H * 60 + 1) * MIN }),
    );
    let sendCalls = 0;
    await handleTick(store, async () => { sendCalls += 1; return true; }, now);
    expect(sendCalls).toBe(1);
    expect(store.saved()?.alerted).toBe(true);
  });

  it("lastNoticeMs 가 아예 없던(신규) 상태는 하한에 걸리지 않는다", async () => {
    const store = fakeStore(silenceReadyState({ lastNoticeMs: null }));
    let sendCalls = 0;
    await handleTick(store, async () => { sendCalls += 1; return true; }, now);
    expect(sendCalls).toBe(1);
  });

  it("하한이 복구 통지를 막지 않는다 — lastNoticeMs 가 최근이어도 복구는 나간다", async () => {
    // 복구는 사용자가 기다리는 신호라 억제 대상이 아니다(설계 명시).
    const store = fakeStore({
      lastBeatMs: now - 47 * MIN,
      missStreak: 9,
      alerted: true,
      lastNoticeMs: now - 5 * MIN, // 방금 침묵 알림을 보낸 직후라고 가정
    });
    let sendCalls = 0;
    await handleBeat(store, async () => { sendCalls += 1; return true; }, now);
    expect(sendCalls).toBe(1);
    expect(store.saved()?.alerted).toBe(false); // 복구 후 재무장
  });

  it("복구가 확정되면 lastNoticeMs 도 지운다 — 그래야 별개의 새 침묵이 옛 알림 시각에 막히지 않는다", async () => {
    // 맥 notify.sh 의 "회복 시 하한 기록을 지운다" 규약과 같다. 안 지우면 복구 후
    // 6시간 안에 재발하는(=완전히 다른 인시던트인) 새 침묵이 옛 알림 시각에 걸려
    // 조용히 묵살된다.
    const store = fakeStore({
      lastBeatMs: now - 47 * MIN,
      missStreak: 9,
      alerted: true,
      lastNoticeMs: now - 5 * MIN,
    });
    await handleBeat(store, async () => true, now);
    expect(store.saved()?.lastNoticeMs).toBeNull();
  });

  it("복구 통지 발송이 실패하면 lastNoticeMs 를 지우지 않는다(복구 미확인)", async () => {
    const store = fakeStore({
      lastBeatMs: now - 47 * MIN,
      missStreak: 9,
      alerted: true,
      lastNoticeMs: now - 5 * MIN,
    });
    await handleBeat(store, async () => false, now);
    expect(store.saved()?.lastNoticeMs).toBe(now - 5 * MIN); // 발송 실패 → 이전 값 유지
  });

  it("복구 후 6시간 안에 재발한 별개의 새 침묵도 즉시 알린다(회귀 재현 — 두 단계)", async () => {
    // 1단계: 침묵 알림이 나가고 5분 뒤 복구된다.
    const store = fakeStore(silenceReadyState({ lastNoticeMs: null }));
    await handleTick(store, async () => true, now); // 침묵 알림 발송 → alerted=true, lastNoticeMs=now
    const afterFirstSilence = now + 5 * MIN;
    await handleBeat(store, async () => true, afterFirstSilence); // 복구 → alerted=false, lastNoticeMs=null
    expect(store.saved()?.lastNoticeMs).toBeNull(); // 전제 확인 — 1단계가 실제로 지웠는지

    // 2단계: 아직 첫 알림으로부터 6시간이 지나지 않은 시점에, 완전히 새로운 침묵이
    // 문턱(경과·연속 관측)을 넘는다. missStreak 를 일일이 6번 쌓는 대신, 복구 직후
    // 저장된 상태(lastNoticeMs=null 이 핵심 관찰 대상)를 그대로 두고 나머지 필드만
    // 새 침묵 직전 상태로 앞당긴다.
    const recovered = store.saved()!;
    await store.put(JSON.stringify({
      ...recovered,
      lastBeatMs: afterFirstSilence - (SILENCE_AFTER_MIN + 1) * MIN,
      missStreak: SILENCE_MIN_OBS - 1,
    }));
    const secondSilenceTick = afterFirstSilence;
    let sendCalls = 0;
    await handleTick(
      store,
      async () => { sendCalls += 1; return true; },
      secondSilenceTick,
    );
    expect(sendCalls).toBe(1); // lastNoticeMs 가 지워지지 않았다면 옛 하한(6시간)에 막혔을 것이다
  });

  it("상태가 바뀌지 않으면 put 을 호출하지 않는다(쓰기 감축 ①)", async () => {
    // 정상 폴링 중(경과 < TICK_MIN)인 안정 상태 — onTick 이 계산하는 next 가 state 와 동일하다.
    const stable: StoredState = {
      lastBeatMs: now - (TICK_MIN - 1) * MIN,
      missStreak: 0,
      alerted: false,
      lastNoticeMs: null,
    };
    const store = fakeStore(stable);
    await handleTick(store, async () => true, now);
    expect(store.putCount).toBe(0);
  });

  it("상태가 바뀌면 put 을 호출한다(음성 대조군 — 위 테스트가 공허 통과가 아님을 확인)", async () => {
    const changing: StoredState = {
      lastBeatMs: now - (SILENCE_AFTER_MIN + 1) * MIN, // missStreak 가 이번 tick 에 증가한다
      missStreak: 0,
      alerted: false,
      lastNoticeMs: null,
    };
    const store = fakeStore(changing);
    await handleTick(store, async () => true, now);
    expect(store.putCount).toBeGreaterThan(0);
  });

  it("240초 이내 연속 beat 는 put 을 호출하지 않는다(쓰기 감축 ②)", async () => {
    const recent: StoredState = {
      lastBeatMs: now - (BEAT_SAVE_DEBOUNCE_MS - 1_000),
      missStreak: 0,
      alerted: false,
      lastNoticeMs: null,
    };
    const store = fakeStore(recent);
    await handleBeat(store, async () => true, now);
    expect(store.putCount).toBe(0);
  });

  it("240초 밖의 beat 는 put 을 호출한다", async () => {
    const stale: StoredState = {
      lastBeatMs: now - (BEAT_SAVE_DEBOUNCE_MS + 1_000),
      missStreak: 0,
      alerted: false,
      lastNoticeMs: null,
    };
    const store = fakeStore(stale);
    await handleBeat(store, async () => true, now);
    expect(store.putCount).toBe(1);
    expect(store.saved()?.lastBeatMs).toBe(now);
  });

  it("첫 beat(state 없음)는 240초 하한과 무관하게 항상 저장된다", async () => {
    const store = fakeStore({ lastBeatMs: null, missStreak: 0, alerted: false, lastNoticeMs: null });
    await handleBeat(store, async () => true, now);
    expect(store.putCount).toBe(1);
    expect(store.saved()?.lastBeatMs).toBe(now);
  });
});

/**
 * I3 회귀 — 문턱 정합이 설계서가 지목한 축(앱 full 폴링 간격)을 실제로 묶는다.
 *
 * 기존 "TICK_MIN * SILENCE_MIN_OBS <= SILENCE_AFTER_MIN" 단언은 Worker 내부
 * 불변식이라 `Config.fullPollSeconds` 가 커져도(예: 40분) 초록으로 통과한다.
 * 그러면 건강한 맥에서도 30분 경과 tick 에 침묵 알림이, 40분 만의 beat 도착에
 * 복구 알림이 영원히 반복된다. 이 테스트는 그 축을 기계로 묶는다 — 기존 단언은
 * 그대로 둔다(서로 다른 불변식).
 */
describe("문턱 정합 — SILENCE_AFTER_MIN ↔ 앱 full 폴링 간격 (I3)", () => {
  const CONSTANTS_SWIFT = path.join(SWIFT_DIR, "Constants.swift");
  const SWIFT_SRC = readFileSync(CONSTANTS_SWIFT, "utf8");

  function swiftTimeInterval(name: string): number {
    const m = new RegExp(`\\b${name}\\s*:\\s*TimeInterval\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(SWIFT_SRC);
    expect(
      m,
      `${name} 를 Constants.swift 에서 찾지 못했다(앵커 함정 — 이름을 바꿨으면 이 테스트도 함께 고칠 것)`,
    ).not.toBeNull();
    return Number(m![1]);
  }

  it("SILENCE_AFTER_MIN 이 full 폴링 간격의 최소 2배다", () => {
    const fullPollMin = swiftTimeInterval("fullPollSeconds") / 60;
    expect(SILENCE_AFTER_MIN).toBeGreaterThanOrEqual(fullPollMin * 2);
  });

  it("양성 프로브 — 없는 변수는 조용히 통과하지 않고 실패로 잡힌다", () => {
    expect(() => swiftTimeInterval("notARealSwiftConstant")).toThrow();
  });
});

/**
 * C2 의 **실행 검증** — 여기까지가 파킹돼 있던 갭이다.
 *
 * 위 「C2 — 재발송 절대 하한」 블록은 `lastNoticeMs` 가 들어 있는 상태를 **직접 주입**해
 * 하한이 작동하는지를 본다. 그래서 "put 이 실패했을 때 그 하한이 애초에 남는가"는
 * 한 번도 실행된 적이 없었다 — 두 리뷰가 코드 추적(클레임 put 과 최종 put 이 분리돼
 * 있다)으로만 확인하고 파킹한 항목이다.
 * (설계 정본 §잔여: "put 실패 시 하한 생존이 실행 테스트로 고정돼 있지 않다.")
 *
 * 갭이 닫히지 않던 이유는 단순하다: 기존 가짜 저장소의 put 이 **절대 실패하지 않아서**
 * 실패 경로를 행사할 수 없었다. 실패를 흉내 내는 저장소 하나로 닫힌다.
 */
describe("C2 실행 검증 — put 이 실패해도 재발송 하한이 살아남는다", () => {
  const MIN = 60_000;
  const now = 1_000_000_000_000; // 고정 기준점 — 시스템 시각을 쓰지 않는다(P9)

  /**
   * put 이 `failFromCall` 번째 호출부터 거부하는 저장소. KV 쓰기 거부(무료 티어 한도
   * 소진·일시 장애·rate limit)를 흉내 낸다. 실패한 put 은 저장 내용을 바꾸지 않는다 —
   * 실제 KV 와 같다. 이 "안 바뀐다"가 검증의 핵심이라 성공 경로와 반드시 구분한다.
   */
  function flakyStore(initial: StoredState, failFromCall: number) {
    let raw: string | null = JSON.stringify(initial);
    const wrapper: StateStore & { putCount: number; saved: () => StoredState | null } = {
      putCount: 0,
      get: async () => raw,
      put: async (value: string) => {
        wrapper.putCount += 1;
        if (wrapper.putCount >= failFromCall) throw new Error("KV write rejected");
        raw = value;
      },
      saved: () => (raw ? parseState(raw) : null),
    };
    return wrapper;
  }

  /** put 이 언제나 성공하는 저장소 — KV 장애가 회복된 다음 tick 을 흉내 낸다. */
  function healthyStore(initial: StoredState) {
    let raw: string | null = JSON.stringify(initial);
    const wrapper: StateStore & { saved: () => StoredState | null } = {
      get: async () => raw,
      put: async (value: string) => {
        raw = value;
      },
      saved: () => (raw ? parseState(raw) : null),
    };
    return wrapper;
  }

  /** 침묵 문턱(경과·관측 횟수)을 둘 다 넘긴 직전 상태 — 다음 tick 에서 반드시 notice 를 만든다. */
  const silenceReadyState = (extra: Partial<StoredState> = {}): StoredState => ({
    lastBeatMs: now - (SILENCE_AFTER_MIN + 1) * MIN,
    missStreak: SILENCE_MIN_OBS - 1,
    alerted: false,
    lastNoticeMs: null,
    ...extra,
  });

  it("양성 프로브 — flakyStore 의 put 이 실제로 거부한다(공허 통과 방지)", async () => {
    const store = flakyStore(silenceReadyState(), 1);
    await expect(store.put("x")).rejects.toThrow("KV write rejected");
  });

  it("클레임 put 은 성공하고 최종 put 이 실패해도 lastNoticeMs 가 남는다", async () => {
    // failFromCall=2 → 1회차(발송 전 클레임)는 성공, 2회차(alerted 를 담은 최종 저장)는 실패.
    const store = flakyStore(silenceReadyState(), 2);
    await expect(handleTick(store, async () => true, now)).rejects.toThrow("KV write rejected");

    expect(store.putCount).toBe(2); // 두 put 이 실제로 분리 호출됐다
    expect(store.saved()?.lastNoticeMs).toBe(now); // 하한은 남았다 ← 이 줄이 파킹 항목의 본체
    expect(store.saved()?.alerted).toBe(false); // 최종 put 이 실패했으니 alerted 는 안 붙었다
  });

  it("그 상태의 다음 tick 은 alerted 가 false 인데도 재발송하지 않는다(하한이 단독으로 막는다)", async () => {
    const broken = flakyStore(silenceReadyState(), 2);
    await expect(handleTick(broken, async () => true, now)).rejects.toThrow();
    const survived = broken.saved();
    expect(survived).not.toBeNull();

    // KV 가 회복된 5분 뒤 tick. alerted=false 라 decide.ts 는 다시 침묵을 판정하지만,
    // lastNoticeMs 하한이 발송을 막아야 한다 — 이것이 C2 층이 존재하는 이유다.
    const recovered = healthyStore(survived!);
    let sendCalls = 0;
    await handleTick(recovered, async () => { sendCalls += 1; return true; }, now + TICK_MIN * MIN);
    expect(sendCalls).toBe(0);
  });

  it("음성 대조군 — 클레임 put 까지 실패하면 하한이 남지 않아 다음 tick 에서 다시 나간다", async () => {
    // failFromCall=1 → 클레임 put 부터 거부. 하한이 심어지지 않는다.
    const store = flakyStore(silenceReadyState(), 1);
    let sendCalls = 0;
    await expect(
      handleTick(store, async () => { sendCalls += 1; return true; }, now),
    ).rejects.toThrow();

    expect(sendCalls).toBe(1); // 클레임 저장 실패는 삼키고 발송 자체는 시도한다
    expect(store.saved()?.lastNoticeMs).toBeNull(); // 하한이 안 남았다

    const recovered = healthyStore(store.saved()!);
    let secondSendCalls = 0;
    await handleTick(recovered, async () => { secondSendCalls += 1; return true; }, now + TICK_MIN * MIN);
    // 위 테스트와 같은 자리에서 결과가 갈린다 — 하한이 남았느냐만 다르다.
    expect(secondSendCalls).toBe(1);
  });
});
