import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 모바일 형태(form) 사다리 계약 — 오너 결정 2026-07-22 · docs/agents/design-system.md.
 *
 * 오너가 모바일 표면에 한해 형태 기준의 가드레일을 풀면서 낸 조건은 하나다:
 * **"우리 내부에서 위계만 잡혀 있으면 됨"**. 그래서 이 테스트가 막는 것은 "토스와
 * 다른 값"이 아니라 **사다리 밖 이탈값**이다(Elevation 사다리 계약과 같은 논리).
 *
 * 왜 문서가 아니라 테스트인가: PR #68 이 프레스 4계층을 P8 문서에 등재했는데도
 * 같은 PR 안에서 3곳이 두 계층을 동시에 적용했다(전폭 버튼에 scale+틴트, 아이콘
 * 버튼에 scale+틴트). 문서만으로는 규율이 유지되지 않는다는 실증이다.
 *
 * ⚠️ 이 사다리의 수치는 **TDS 원문 스펙이 아니다.** apps-in-toss MCP 실측 결과
 * TDS Web 문서에는 radius·버튼 치수·모션 duration 의 px 값이 존재하지 않는다
 * (Foundation 에 Typography·Colors 2개뿐, 값 표는 렌더 컴포넌트로 대체됨).
 * 따라서 여기 값들은 **이 코드베이스에 이미 있던 암묵적 사다리를 명시화한 것**이고,
 * TDS 에서 가져온 것은 "요소 종류에 따라 프레스 피드백을 다르게 쓴다"는 구조뿐이다.
 */

const MOBILE_DIR = join(process.cwd(), "src/components/mobile");

function listMobileSourceFiles(): string[] {
  return readdirSync(MOBILE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(MOBILE_DIR, entry.name));
}

/**
 * 주석을 같은 길이의 공백으로 치환한다(줄번호 보존).
 * 이 폴더는 판정 근거를 className 안쪽 주석으로 남기는 관례가 있어서, 스트립하지
 * 않으면 설명용으로 적어둔 클래스명이 위반으로 잡힌다(css-token-idiom-contract 선례).
 */
function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/**
 * `className="…"` 와 `className={cn(…)}` 양쪽에서 클래스 문자열 덩어리를 뽑는다.
 * 프레스 계층 검사는 **한 요소 안에서** 두 계층이 겹쳤는지를 봐야 하므로 파일 전체가
 * 아니라 요소 단위 덩어리가 필요하다(줄 단위로 보면 cn() 여러 줄에 나뉜 경우를 놓친다).
 */
function extractClassBlobs(source: string): string[] {
  const blobs: string[] = [];
  const marker = /className=/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(source)) !== null) {
    const start = match.index + match[0].length;
    const opener = source[start];

    if (opener === '"' || opener === "'" || opener === "`") {
      const end = source.indexOf(opener, start + 1);
      if (end > start) blobs.push(source.slice(start + 1, end));
      continue;
    }

    if (opener === "{") {
      let depth = 0;
      let index = start;
      for (; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      blobs.push(source.slice(start + 1, index));
    }
  }

  return blobs;
}

function relative(file: string): string {
  return file.replace(process.cwd() + "/", "");
}

describe("모바일 형태 사다리 — 라디우스 4단", () => {
  /**
   * 2xl(카드·시트·전폭 표면) > xl(카드 안 인터랙티브: 버튼·탭아이템·아이콘버튼)
   * > md(칩·배지·소형 라벨) > full(원형·필).
   *
   * 방향 지정(rounded-t/l/r…)은 캘린더 스팬바처럼 "한쪽만 깎는" 별개 축이라 대상이
   * 아니다. rounded-none 은 명시적 무-라운드 선언이다.
   */
  const OFF_LADDER = /\brounded-(sm|lg|3xl|4xl)\b/g;
  const ARBITRARY = /\brounded-\[[^\]]*\]/g;

  it("사다리 밖 라디우스 단계를 쓰지 않는다", () => {
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const source = stripComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        for (const [value] of line.matchAll(OFF_LADDER)) {
          offenders.push(
            `${relative(file)}:${index + 1} — ${value} — 사다리 밖 단계다. ` +
              `rounded-2xl(카드) / rounded-xl(인터랙티브) / rounded-md(칩) / rounded-full 중에서 골라라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("임의 라디우스 값(rounded-[Npx])을 쓰지 않는다", () => {
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const source = stripComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        for (const [value] of line.matchAll(ARBITRARY)) {
          offenders.push(
            `${relative(file)}:${index + 1} — ${value} — 임의값이다. ` +
              `사다리 단계를 쓰거나, 새 단계가 정말 필요하면 P8 문서에 먼저 등재하라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("사다리 4단이 모두 실제로 쓰인다 — 죽은 단계 방지", () => {
    const all = listMobileSourceFiles()
      .map((file) => stripComments(readFileSync(file, "utf8")))
      .join("\n");

    for (const step of ["rounded-2xl", "rounded-xl", "rounded-md", "rounded-full"]) {
      expect(all.includes(step), `${step} 소비처 없음 — 죽은 단계`).toBe(true);
    }
  });
});

describe("모바일 프레스 상태 — 표면당 정확히 한 계층", () => {
  /**
   * ① 딤 = 전폭 카드·전폭 버튼·탭바 ② 축소 = **그리드 타일 전용**
   * ③ bg 틴트 = 목록 행·아이콘 버튼 ④ opacity = 텍스트 링크. (오너 결정 2026-07-22)
   *
   * 두 계층을 겹치면 프레스가 "줄어들면서 동시에 어두워지는" 이중 신호가 되어,
   * 계층이 표면 종류를 구분하는 기능 자체가 사라진다. TDS 도 요소별로 방식을
   * 나눠 쓴다(Button=딤 오버레이 / GridList.Item=확대) — 겹쳐 쓰지 않는다.
   *
   * 딤의 구현은 **면이 있느냐**로 갈린다: 배경이 있는 표면은 `brightness`,
   * 배경이 투명한 표면(비활성 탭)은 `opacity` — filter 는 렌더 결과에 곱연산이라
   * 투명한 곳에서는 어두워질 픽셀이 없어 사실상 무피드백이 된다.
   */
  it("한 요소가 scale 과 배경 틴트를 동시에 쓰지 않는다", () => {
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const blob of extractClassBlobs(source)) {
        const hasScale = /active:scale-/.test(blob);
        const hasTint = /active:bg-/.test(blob);
        if (hasScale && hasTint) {
          offenders.push(
            `${relative(file)} — active:scale 과 active:bg 가 같은 요소에 함께 있다. ` +
              `P8 "모바일 프레스 상태 언어"에서 표면 유형에 맞는 계층 하나만 골라라.`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * 축소(scale)는 **그리드 타일 전용**이다 (오너 결정 2026-07-22).
   *
   * 토스는 버튼·행을 누르면 어두워지고(딤), 확대·축소는 `GridList.Item` 에만 쓴다.
   * 전폭 카드까지 축소하면 목록이 길 때 여러 장이 함께 흔들려 보인다 — 오너가
   * 실물 샘플에서 딤을 골랐다. 새 타일을 추가할 때만 이 목록을 늘린다.
   */
  const SCALE_ALLOWED: { file: string; why: string }[] = [
    {
      file: "mobile-home-settlement-card.tsx",
      why: "입금/지급 대기 타일 — grid-cols-2 안의 콘텐츠 타일",
    },
    {
      file: "mobile-schedule-calendar.tsx",
      why: "날짜 셀 — grid-cols-7 안의 콘텐츠 타일",
    },
  ];

  it("축소는 그리드 타일에서만 쓴다 — 전폭 카드·버튼은 딤", () => {
    const allowed = new Set(SCALE_ALLOWED.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const base = file.split("/").pop() ?? "";
      if (allowed.has(base)) continue;

      const source = stripComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        for (const [value] of line.matchAll(/\bactive:scale-[\w[\].]+/g)) {
          offenders.push(
            `${relative(file)}:${index + 1} — ${value} — 축소는 그리드 타일 전용이다. ` +
              `전폭 카드·버튼은 active:brightness-95(딤), 목록 행·아이콘 버튼은 bg 틴트를 써라. ` +
              `진짜 타일이면 이 테스트의 SCALE_ALLOWED 에 근거와 함께 등재하라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("터치 표면에 hover 를 두지 않는다 — iOS sticky-hover 방지", () => {
    // shadcn Badge 의 기본 hover 를 무력화하는 no-op(`hover:bg-primary/10` = 평상시
    // 배경과 동일)만 예외다. 이건 hover 상태를 "추가"하는 게 아니라 "제거"하는 코드다.
    const NOOP_BADGE_HOVER = "hover:bg-primary/10";
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const source = stripComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        for (const [value] of line.matchAll(/\bhover:[a-z0-9:/[\]._-]+/g)) {
          if (value === NOOP_BADGE_HOVER) continue;
          offenders.push(
            `${relative(file)}:${index + 1} — ${value} — 모바일은 터치 전용 표면이다. ` +
              `hover 는 iOS 에서 탭 후 잔상으로 남는다 — active: 로 바꿔라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe("모바일 행 여백 — 좌우 24 (오너 결정 2026-07-22, TDS ListRow)", () => {
  /**
   * 목록 행은 `px-6 py-3`, 헤더 행은 `px-6 py-2`.
   *
   * 이 계약이 없어서 첫 스윕이 두 곳을 놓쳤다(정산 대기 시트의 빈 상태 문구가 옛
   * `px-3.5` 에 멈춰 같은 카드가 데이터 유무에 따라 좌측 인셋이 달라졌다).
   * 라디우스와 달리 여백은 "빠뜨림"이 조용해서 사람 눈에만 의존하면 반드시 남는다.
   *
   * 검사 대상은 **행처럼 생긴 것**(`min-h-11` + 좌우 패딩)이다. 예외는 아래 3종.
   */
  const NESTED_EXCEPTIONS: { file: string; why: string }[] = [
    {
      file: "mobile-draft-campaign-sheet.tsx",
      why: "셀러·딜 자동완성 드롭다운 — 시트 px-3 + 카드 p-3.5 두 겹 안이라 24 면 트리거 인풋과 12px 어긋난다",
    },
    {
      file: "mobile-campaign-detail-sheet.tsx",
      why: "품목별 매출 상세 — 4열 데이터 표와 그 토글 헤더. 24 면 열이 눌리고 헤더만 올리면 표와 어긋난다",
    },
  ];

  it("목록 행이 좌우 24(px-6)를 쓴다", () => {
    const exempt = new Set(NESTED_EXCEPTIONS.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const base = file.split("/").pop() ?? "";
      if (exempt.has(base)) continue;

      const source = stripComments(readFileSync(file, "utf8"));
      for (const blob of extractClassBlobs(source)) {
        // 행 후보: 터치 최소 높이(min-h-11)를 선언하고 좌우 패딩을 가진 것.
        if (!/\bmin-h-11\b/.test(blob)) continue;
        // `shrink-0` 은 행이 아니라 **줄 안에 얹힌 인라인 액션**(예: 헤더 우측
        // "+ 예비 일정")이다 — min-h-11 은 행이라서가 아니라 터치 하한 때문에 붙는다.
        if (/\bshrink-0\b/.test(blob)) continue;
        const pad = blob.match(/\bpx-([\d.]+)\b/);
        if (!pad) continue;
        if (pad[1] === "6") continue;
        offenders.push(
          `${relative(file)} — px-${pad[1]} — 목록 행 좌우 여백은 px-6(24px)이다. ` +
            `타일·중첩 위젯이면 이 테스트의 NESTED_EXCEPTIONS 에 근거와 함께 등재하라.`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it("탭 화면 거터가 px-5(20px)로 통일돼 있다", () => {
    // 오너 결정 2026-07-22(절충안): 행 24 로 올리며 생긴 거터(16) < 행(24) 역전을
    // 4px 까지 좁힌다. 24 로 완전히 맞추지 않은 이유는 카드 폭 손실(358→342px)이
    // 긴 셀러·딜명의 말줄임을 늘리기 때문 — 20 이면 손실 8px 로 절반이다.
    //
    // `app/pipeline/loading.tsx` 도 대상이다. 로딩↔본문 높이·여백이 어긋나면 iOS 가
    // 하단 nav 의 position:fixed 를 스테일 오프셋으로 그리는 회귀(#192)가 재발한다.
    const targets = [
      ...listMobileSourceFiles(),
      join(process.cwd(), "src/app/pipeline/loading.tsx"),
    ];
    const offenders: string[] = [];

    for (const file of targets) {
      const source = stripComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        if (!line.includes("mobile-tab-safe-top")) return;
        const pad = line.match(/\bpx-([\d.]+)\b/);
        if (!pad || pad[1] === "5") return;
        offenders.push(
          `${relative(file)}:${index + 1} — px-${pad[1]} — 탭 화면 거터는 px-5(20px)다.`,
        );
      });
    }

    expect(offenders).toEqual([]);
  });

  it("같은 카드 안에서 빈 상태 문구가 행과 같은 인셋을 쓴다", () => {
    // 실사고: 정산 대기 시트에서 MobileSheetRow 만 px-6 로 옮기고 "대기 없음" 문구는
    // px-3.5 에 남아, 데이터가 있을 때와 없을 때 좌측 정렬이 달라졌다.
    const source = stripComments(
      readFileSync(join(MOBILE_DIR, "mobile-settlement-pending-sheet.tsx"), "utf8"),
    );
    const emptyRow = extractClassBlobs(source).find((blob) => /border-t border-slate-100/.test(blob));
    expect(emptyRow, "빈 상태 문구를 찾지 못했다 — 셀렉터가 낡았는지 확인하라").toBeTruthy();
    expect(emptyRow).toMatch(/\bpx-6\b/);
  });
});

describe("모바일 구분선 — 2단 위계", () => {
  /**
   * 행 헤어라인 = border-slate-100 · 섹션 경계 = border-slate-200/60.
   *
   * 두 단은 의도적으로 다르다(섹션 경계가 더 진하다). 정리 대상은 이 두 단이 아니라
   * **같은 역할에 붙은 다른 이름**이었다 — border-border/60(=slate-900 4.8% alpha)은
   * slate-100 과 사실상 같은 값인데 이름만 달랐고, /40 은 /60 과 1.6%p 차이라
   * 위계로 읽히지 않았다(PR #68 이 slate-50→slate-100 만 수렴하고 남긴 절반).
   */
  const ALLOWED_DIVIDER = /^(slate-100|slate-200\/60)$/;

  const EXCEPTIONS: { file: string; token: string; why: string }[] = [
    {
      file: "src/components/mobile/mobile-home-view.tsx",
      token: "white/10",
      why: "매출 목표 히어로의 네이비 표면 — 흰 카드가 아니라서 slate 헤어라인이 보이지 않는다(P8 '토큰은 표면 종속')",
    },
  ];

  it("행/섹션 구분선이 2단 위계 밖 토큰을 쓰지 않는다", () => {
    const offenders: string[] = [];

    for (const file of listMobileSourceFiles()) {
      const rel = relative(file);
      const source = stripComments(readFileSync(file, "utf8"));

      source.split("\n").forEach((line, index) => {
        for (const match of line.matchAll(/\bborder-[tb] border-([a-z0-9/[\].-]+)/g)) {
          const token = match[1];
          if (ALLOWED_DIVIDER.test(token)) continue;
          if (EXCEPTIONS.some((entry) => entry.file === rel && entry.token === token)) continue;
          offenders.push(
            `${rel}:${index + 1} — border-${token} — 구분선 2단 위계 밖이다. ` +
              `행 헤어라인은 border-slate-100, 섹션 경계는 border-slate-200/60 을 써라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
