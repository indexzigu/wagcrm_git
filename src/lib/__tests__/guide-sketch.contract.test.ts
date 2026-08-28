// 촬영 컷 시안 계약 (2026-08-01).
//
// 이 파일이 지키는 것은 셋이다. 셋 다 완화되면 조용히 사고가 된다:
//   ① **스타일 락** — 이 문구가 "촬영 지시서 스케치"와 "제품 사진"을 가르는 유일한
//      장치다. 실물과 다른 제품 이미지는 셀러에게 잘못된 기준을 주고 표시광고 측면에서도
//      근거 없는 시각 주장이 된다. 완화는 오너 승인 사안.
//   ② **비용 상한** — 이미지는 텍스트보다 단위 비용이 100배대라, 모델이 컷을 많이 뱉는
//      응답 하나가 곧 비용 사고다. 프롬프트는 3~5컷을 요구하지만 출력은 보장이 아니다.
//   ③ **캐시 키의 정의** — 시안이 컷 텍스트의 함수라는 것이 재생성 비용 0의 근거다.
//      키에 `why`(카피)를 넣으면 문구만 다듬어도 돈이 나간다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  SKETCH_STYLE_LOCK,
  SKETCH_ASPECT_RATIO,
  SKETCH_IMAGE_SIZE,
  MAX_SKETCHES_PER_GUIDE,
  cutSketchKey,
  buildSketchPrompt,
  cutMedium,
  SKETCH_PROMPT_VERSION,
  cutAsksForOnScreenText,
  planSketches,
  sketchFrameStatus,
  SKETCH_STATUS_LABEL,
  type SketchProgress,
  classifySketchFailure,
  SKETCH_FAILURE_LABEL,
  sketchFrameLabel,
  mergeSketches,
  parseStoredSketches,
  sketchStoragePath,
} from "../guide-sketch";
import type { GuideCut } from "../content-guide";

const cut = (over: Partial<GuideCut> = {}): GuideCut => ({
  no: "1",
  slot: "0~3초",
  subject: "알약 여섯 알을 손바닥에 쏟는다",
  why: "문제를 3초 안에 보여준다",
  ...over,
});

const product = { name: "유산균 분말 스틱", category: "건강기능식품" };

describe("스타일 락 — 제품 사진으로 새지 않게 하는 장치 (긍정 서술)", () => {
  // ⚠️ 아래 넷은 종전 부정문 4줄이 지키던 것과 **같은 의도**다. 표현만 긍정형으로
  // 옮겼다 — 완화가 아니다. 부정문이 실제로 샜다는 실측이 근거다(아래 회귀 검사).
  it("완성 일러스트·제품 사진이 아님을 명시한다", () => {
    expect(SKETCH_STYLE_LOCK).toMatch(/rather than a finished illustration or a product photo/i);
    expect(SKETCH_STYLE_LOCK).toMatch(/pencil strokes/i);
  });

  it("모든 면을 '비어 있는 상태'로 서술한다 — 글자가 들어설 자리를 만들지 않는다", () => {
    expect(SKETCH_STYLE_LOCK).toMatch(/plain and unmarked/i);
    expect(SKETCH_STYLE_LOCK).toMatch(/empty outlines/i);
  });

  it("얼굴은 금지가 아니라 **크롭 지시**로 처리한다", () => {
    expect(SKETCH_STYLE_LOCK).toMatch(/cropped below the chin/i);
  });

  it("제품은 장면이 서술한 만큼만·단순한 형태로 그리게 한다", () => {
    expect(SKETCH_STYLE_LOCK).toMatch(/only as far as the scene describes/i);
    expect(SKETCH_STYLE_LOCK).toMatch(/simple and generic/i);
  });

  /**
   * ⛔ 부정문 회귀 금지 (실측 2026-08-02).
   *
   * 종전 락은 `Do NOT render any text…` 등 금지문 4줄이었는데 **그 금지가 샜다** —
   * 프로덕션 시안에 숫자·필기체가 그려졌고, 비교 생성에서는 프롬프트 단어가 그대로
   * 그림 속 영문 주석이 됐다("SOFT SPARKLE" · "SCENE 2"). 긍정 서술로 바꾼 회차는
   * 2연속 글자 0 건이었다. 부정문을 되살리려면 그 실측부터 뒤집어야 한다.
   */
  it("부정 지시문으로 되돌아가지 않는다", () => {
    expect(SKETCH_STYLE_LOCK).not.toMatch(/\bDo NOT\b/i);
    expect(SKETCH_STYLE_LOCK).not.toMatch(/\bNo shading\b|\bno color\b/i);
  });

  it("프롬프트는 스타일 락을 **맨 뒤**에 둔다 — 서두 가중치는 피사체가 갖는다", () => {
    // 종전에는 맨 앞이었다. 이 모델은 서두에 가장 큰 가중치를 주므로 그 자리는
    // "무엇을 그릴 것인가"가 차지해야 한다(조사 채택분 + G 회차 실측).
    expect(buildSketchPrompt(cut(), product).endsWith(SKETCH_STYLE_LOCK)).toBe(true);
  });

  it("프롬프트에 컷의 피사체가 들어간다", () => {
    expect(buildSketchPrompt(cut(), product)).toContain("알약 여섯 알을 손바닥에 쏟는다");
  });
});

describe("상품 정체 주입 — 없으면 모델이 카테고리를 지어낸다", () => {
  // 실사고(2026-08-02): 쥬얼리 딜 시안에 화장품 튜브·팔레트가 그려졌다. 원인은
  // 이미지 프롬프트에 상품이 한 번도 전달되지 않았던 것이다.
  it("상품명이 프롬프트에 들어간다", () => {
    expect(buildSketchPrompt(cut(), product)).toContain("유산균 분말 스틱");
  });

  it("카테고리가 있으면 함께 들어간다", () => {
    expect(buildSketchPrompt(cut(), product)).toContain("건강기능식품");
  });

  it("카테고리가 없어도 상품명만으로 조립된다", () => {
    const p = buildSketchPrompt(cut(), { name: "보조배터리", category: null });
    expect(p).toContain("보조배터리");
    expect(p).not.toContain("()");
  });

  it("상품은 **맨 앞 문장**에 온다 — 서두 가중치", () => {
    const first = buildSketchPrompt(cut(), product).split("\n")[0];
    expect(first).toContain("유산균 분말 스틱");
  });
});

describe("매체 분기 — 카드뉴스를 영상으로 조립하지 않는다", () => {
  // 실측(2026-08-02): 피드 컷도 `shot N of a short-form vertical video, at 첫 장`
  // 으로 조립됐다. 매체가 틀리면 모델이 그리는 화면 구성 자체가 어긋난다.
  it("시간 자리는 영상이다", () => {
    expect(cutMedium(cut({ slot: "0~3초" }))).toBe("VIDEO");
    expect(cutMedium(cut({ slot: "3~10초" }))).toBe("VIDEO");
  });

  it("`첫 장`·`2장` 은 카드뉴스다", () => {
    expect(cutMedium(cut({ slot: "첫 장" }))).toBe("CARD");
    expect(cutMedium(cut({ slot: "2장" }))).toBe("CARD");
  });

  it("영상 컷은 세로 영상 앱 화면으로, 카드 컷은 피드 카드로 조립된다", () => {
    expect(buildSketchPrompt(cut({ slot: "0~3초" }), product)).toContain("vertical video app");
    expect(buildSketchPrompt(cut({ slot: "첫 장" }), product)).toContain("photo-feed post");
  });

  it("컷이 화면 글자를 요구하면 '자리를 비우라'로 번역한다", () => {
    // 실측: `훅 문구 배치` 컷에서 모델이 **가이드에 없는 한글 카피**를 그림에 렌더했다
    // ("나를 빛내줄, 쥬얼리 컬렉션"). 스타일 락보다 장면 서술이 앞이라 그쪽이 이긴다.
    const p = buildSketchPrompt(cut({ subject: "인물 상반신에 훅 문구 배치" }), product);
    expect(p).toContain("calm empty band");
    expect(cutAsksForOnScreenText(cut({ subject: "공구 혜택가 자막과 함께" }))).toBe(true);
  });

  it("글자를 요구하지 않는 컷에는 그 문장을 넣지 않는다 — 어휘 노출 최소화", () => {
    // 항상 넣으면 글자 관련 어휘가 불필요하게 노출돼 그 자체가 그려질 후보가 된다.
    expect(cutAsksForOnScreenText(cut())).toBe(false);
    expect(buildSketchPrompt(cut(), product)).not.toContain("calm empty band");
  });

  it("서비스명을 부르지 않는다 — 이름을 부르면 UI 라벨 글자까지 딸려온다", () => {
    // F 회차 실측: `Instagram Reels` 를 명시했더니 아이콘은 정확했지만 주석 글자가
    // 대량으로 그려졌다. E·G 회차(형상으로만 서술)는 글자 0 건.
    for (const slot of ["0~3초", "첫 장"]) {
      const p = buildSketchPrompt(cut({ slot }), product);
      expect(p).not.toMatch(/instagram|reels|tiktok/i);
    }
  });
});

describe("이미지 규격 — SDK 타입에서 확인한 값이어야 한다", () => {
  it("릴스 세로 비율", () => {
    expect(SKETCH_ASPECT_RATIO).toBe("9:16");
  });

  it("`512px` 이 아니라 `512` 다 — SDK 유니온이 그렇다", () => {
    expect(SKETCH_IMAGE_SIZE).toBe("512");
    expect(SKETCH_IMAGE_SIZE).not.toContain("px");
  });
});

describe("캐시 키 — 재생성 비용 0의 근거", () => {
  it("자리와 피사체가 같으면 같은 키다", () => {
    expect(cutSketchKey(cut())).toBe(cutSketchKey(cut()));
  });

  it("카피(`why`)만 바뀌면 키가 그대로다 — 문구 손질에 돈이 나가면 안 된다", () => {
    expect(cutSketchKey(cut({ why: "완전히 다른 설명" }))).toBe(cutSketchKey(cut()));
  });

  it("컷 번호만 바뀌면 키가 그대로다 — 순서 교체로 다시 그리지 않는다", () => {
    expect(cutSketchKey(cut({ no: "3" }))).toBe(cutSketchKey(cut()));
  });

  it("피사체가 바뀌면 키가 바뀐다 — 그림이 달라져야 하니까", () => {
    expect(cutSketchKey(cut({ subject: "스틱을 뜯는다" }))).not.toBe(cutSketchKey(cut()));
  });

  it("키는 16자리 hex 다 — 저장 경로 형태가 바뀌면 기존 시안을 못 찾는다", () => {
    expect(cutSketchKey(cut())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("공백만 다른 입력은 같은 키다 — trim 규약", () => {
    expect(cutSketchKey(cut({ slot: "  훅  ", subject: "  손이 스틱을 든다  " }))).toBe(
      cutSketchKey(cut({ slot: "훅", subject: "손이 스틱을 든다" }))
    );
  });

  it("한글·이모지가 섞여도 안정적이다 — 바이트 인코딩 경로 확인", () => {
    const emoji = cut({ subject: "손이 스틱을 든다 ✨" });
    expect(cutSketchKey(emoji)).toBe(cutSketchKey(emoji));
    expect(cutSketchKey(emoji)).toMatch(/^[0-9a-f]{16}$/);
    expect(cutSketchKey(emoji)).not.toBe(cutSketchKey(cut()));
  });

  /**
   * ⛔ **이 값이 바뀌면 이미 저장된 시안이 전부 고아가 된다.**
   *
   * 이 키는 컷↔시안을 잇는 유일한 끈이고, 그림은 `DealGuideDraft.sketches` 에
   * `{key, url}` 로 **키와 함께** 저장돼 있다. 해시 함수를 바꾸면 같은 컷이 다른 키를
   * 내므로 화면은 저장분을 못 찾고 프레임이 조용히 빈 채로 남는다 — 오류도 로그도
   * 없이 "시안이 사라졌다"로만 보인다.
   *
   * 실사고(2026-08-02): #232 가 클라이언트 번들에서 `node:crypto` 를 걷어내며
   * sha256 → FNV-1a 로 바꿨고, 6분 전에 그려 둔 시안 4장이 그대로 고아가 됐다.
   * 위 검사들은 전부 **상대 비교**(같은 입력→같은 출력, 다른 입력→다른 출력)라
   * 해시를 통째로 갈아도 9건 모두 통과했다 — 그래서 절대값을 박는다.
   *
   * 이 테스트가 깨졌다면 **어느 경우인지 먼저 가른다 — 판단 기준은 "기존 그림을
   * 그대로 살려야 하는가"다.**
   *
   *   ① 해시 함수만 바뀌었다(같은 그림을 다른 키로 부르게 됨) → 되돌리거나,
   *      재키잉(`scripts/rekey-guide-sketches.ts`)을 **같은 PR 에서** 함께 낸다.
   *   ② 프롬프트·화풍이 바뀌었다(그림 자체가 달라져야 함) → `SKETCH_PROMPT_VERSION`
   *      을 올려 **의도적으로 무효화**하고 기대값을 갱신한다. 옛 그림은 고아가 되는
   *      것이 맞다 — 살리면 낡은 화풍이 영원히 재사용된다.
   *
   * 어느 쪽이든 **왜 바뀌었는지 커밋에 남기지 않고 기대값만 고쳐 통과시키는 것**이
   * 금지 대상이다. 그것이 #232 사고의 형태였다.
   *
   * 현재: v2 — 화풍 전면 개편(긍정 서술·피사체 우선·UI 형상·상품 주입, 2026-08-02).
   */
  it("골든 키 — 해시 교체를 상대 비교로는 못 잡는다", () => {
    expect(cutSketchKey(cut())).toBe("437ab8166f89e615");
    expect(cutSketchKey(cut({ slot: "훅", subject: "손이 스틱을 든다 ✨" }))).toBe(
      "44dd8416c566c07b",
    );
  });

  it("키에 프롬프트 세대가 들어간다 — 화풍을 바꿔도 옛 그림이 재사용되면 안 된다", () => {
    // 이 검사가 없으면 스타일 락을 갈아도 캐시가 그대로 맞아 낡은 화풍이 살아남는다
    // (#232 의 정반대 실패: 그때는 멀쩡한 그림이 고아가 됐고, 이건 낡은 그림이 남는다).
    expect(SKETCH_PROMPT_VERSION).toMatch(/^v\d+$/);
    expect(cutSketchKey(cut())).not.toBe(
      // v1 기준값(버전 없이 `slot|subject` 만 넣던 시절)
      "63285b721838ed3f",
    );
  });

  /**
   * ── 유형 네임스페이스 (2026-08-02, 가이드 2원화) ─────────────────────────
   *
   * 지키는 것은 **두 가지가 동시에** 성립한다는 사실이다:
   *   ① 셀러형과 브랜드형이 **같은 컷에서 다른 키**를 낸다 — 아니면 한쪽이 그린
   *      그림이 다른 쪽 프레임에 조용히 걸린다(오류도 로그도 없다). 두 유형이 같은
   *      딜에서 같은 자리·같은 피사체를 쓰는 것은 드물지 않다.
   *   ② 셀러형 키가 **종전과 바이트 단위로 같다** — 저장된 시안은 전부 그 유형이고,
   *      키가 바뀌면 멀쩡한 그림이 통째로 고아가 된다(#232 와 같은 실패 모드).
   *
   * ②를 위해 셀러형만 네임스페이스 토큰을 붙이지 않는 **비대칭**을 뒀다. "대칭이
   * 깔끔하다"는 이유로 정리하면 ②가 깨진다 — 되살리려면 프로덕션 쓰기
   * (`scripts/rekey-guide-sketches.ts --apply`, 오너 게이트)가 필요하다.
   */
  describe("유형 네임스페이스", () => {
    it("셀러형 키는 유형 도입 이전과 같다 — 저장된 시안이 고아가 되지 않는다", () => {
      // 위 골든 키와 **같은 값**이다. 유형 인자를 명시해도 기본값과 같아야 한다.
      expect(cutSketchKey(cut(), "CONTENT_GUIDE")).toBe("437ab8166f89e615");
      expect(cutSketchKey(cut())).toBe(cutSketchKey(cut(), "CONTENT_GUIDE"));
    });

    it("브랜드형은 같은 컷에서도 다른 키다 — 유형끼리 시안을 재사용하지 않는다", () => {
      expect(cutSketchKey(cut(), "BRAND_CONTENT_GUIDE")).toBe(
        "d6f85452a85e6249",
      );
      expect(cutSketchKey(cut(), "BRAND_CONTENT_GUIDE")).not.toBe(
        cutSketchKey(cut(), "CONTENT_GUIDE"),
      );
      // 자리까지 똑같이 겹치는 카드형 컷이 실제 충돌 지점이다.
      const card = cut({ slot: "첫 장", subject: "제품 3종을 나란히 놓는다" });
      expect(cutSketchKey(card, "BRAND_CONTENT_GUIDE")).not.toBe(
        cutSketchKey(card, "CONTENT_GUIDE"),
      );
    });

    it("저장 경로도 같은 규칙을 따른다 — 셀러형은 레거시 평면 경로", () => {
      expect(sketchStoragePath("deal1", "abc", "CONTENT_GUIDE")).toBe(
        "deals/deal1/sketches/abc.jpg",
      );
      expect(sketchStoragePath("deal1", "abc")).toBe(
        sketchStoragePath("deal1", "abc", "CONTENT_GUIDE"),
      );
      expect(sketchStoragePath("deal1", "abc", "BRAND_CONTENT_GUIDE")).toBe(
        "deals/deal1/sketches/BRAND_CONTENT_GUIDE/abc.jpg",
      );
    });

    it("계획·병합이 유형을 존중한다 — 유형이 다르면 캐시 적중이 아니다", () => {
      const cuts = [cut()];
      const stored = [
        { key: cutSketchKey(cut(), "CONTENT_GUIDE"), url: "https://x/s.jpg" },
      ];
      // 셀러형: 저장분이 그대로 맞는다(재생성 비용 0).
      const sellerPlan = planSketches(cuts, stored, 8, "CONTENT_GUIDE");
      expect(sellerPlan.reused).toHaveLength(1);
      expect(sellerPlan.toDraw).toHaveLength(0);
      // 브랜드형: 같은 컷이지만 남의 그림이라 새로 그려야 한다.
      const brandPlan = planSketches(cuts, stored, 8, "BRAND_CONTENT_GUIDE");
      expect(brandPlan.reused).toHaveLength(0);
      expect(brandPlan.toDraw).toHaveLength(1);
      // 병합도 같은 네임스페이스를 써야 한다 — 아니면 방금 그린 것이 목록에서 빠진다.
      const drawn = [
        {
          key: cutSketchKey(cut(), "BRAND_CONTENT_GUIDE"),
          url: "https://x/b.jpg",
        },
      ];
      expect(mergeSketches(cuts, [], drawn, "BRAND_CONTENT_GUIDE")).toEqual(
        drawn,
      );
      expect(mergeSketches(cuts, [], drawn, "CONTENT_GUIDE")).toEqual([]);
    });
  });
});

/**
 * 재발 방지 — 이 모듈은 클라이언트 컴포넌트(`content-guide-view.tsx`)가 직접 import 한다.
 * Node 전용 API 가 들어오면 `deals-panel → content-guide-view → guide-sketch` 경로로
 * 클라이언트 번들에 끌려가 로컬 dev(webpack)에서 컴파일이 통째로 선다 —
 * 딜 화면에 들어가는 순간 그 dev 세션 전체가 막혔다(실사고).
 *
 * 소스를 문자열로 스캔한다: 타입 검사도 테스트 실행도 이 유입을 잡지 못한다(서버에서는
 * 정상 동작하기 때문에 vitest 는 node 환경에서 통과한다).
 */
describe("클라이언트 번들 안전성 — Node 전용 API 유입 금지", () => {
  // cwd 기준 경로 — 이 레포의 다른 소스 스캔 계약 테스트와 같은 관례
  // (cron-jobs·dashboard-settlement-sot 등).
  const SOURCE = readFileSync(join(process.cwd(), "src/lib/guide-sketch.ts"), "utf8");

  it("node: 프로토콜 import 가 없다", () => {
    expect(SOURCE).not.toMatch(/from\s+["']node:/);
  });

  it("crypto·fs·path 등 Node 코어 모듈을 import 하지 않는다", () => {
    expect(SOURCE).not.toMatch(/from\s+["'](crypto|fs|path|os|buffer)["']/);
  });

  it("양성 대조군 — 스캔이 실제로 동작한다(하네스 고장 탐지)", () => {
    // 이 파일이 비었거나 못 읽혔으면 위 두 검사가 무의미하게 통과한다.
    expect(SOURCE).toContain("export function cutSketchKey");
    expect(SOURCE.length).toBeGreaterThan(500);
  });
});

describe("planSketches — 무엇을 그리고 무엇을 재사용하나", () => {
  it("캐시에 있으면 그리지 않는다", () => {
    const c = cut();
    const plan = planSketches([c], [{ key: cutSketchKey(c), url: "https://x/1.jpg" }]);
    expect(plan.toDraw).toHaveLength(0);
    expect(plan.reused).toHaveLength(1);
  });

  it("캐시에 없으면 그린다", () => {
    const plan = planSketches([cut()], []);
    expect(plan.toDraw).toHaveLength(1);
  });

  it("상한을 넘으면 그리지 않고 **키로** 남긴다 — 화면이 그 프레임을 표시해야 한다", () => {
    const many = Array.from({ length: MAX_SKETCHES_PER_GUIDE + 3 }, (_, i) =>
      cut({ no: String(i + 1), subject: `장면 ${i}` }),
    );
    const plan = planSketches(many, []);
    expect(plan.toDraw).toHaveLength(MAX_SKETCHES_PER_GUIDE);
    expect(plan.skippedKeys).toHaveLength(3);
    // 개수가 아니라 키다 — 개수만으로는 어느 프레임이 미생성인지 못 가린다.
    expect(plan.skippedKeys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
  });

  it("상한은 **새로 그리는 것**에만 건다 — 캐시 재사용은 비용 0이라 막을 이유가 없다", () => {
    const many = Array.from({ length: MAX_SKETCHES_PER_GUIDE + 3 }, (_, i) =>
      cut({ no: String(i + 1), subject: `장면 ${i}` }),
    );
    const stored = many.map((c) => ({ key: cutSketchKey(c), url: "https://x/c.jpg" }));
    const plan = planSketches(many, stored);
    expect(plan.toDraw).toHaveLength(0);
    expect(plan.skippedKeys).toHaveLength(0);
    expect(plan.reused).toHaveLength(many.length);
  });

  it("같은 장면이 두 컷에 나와도 한 번만 그린다", () => {
    const plan = planSketches([cut({ no: "1" }), cut({ no: "2" })], []);
    expect(plan.toDraw).toHaveLength(1);
  });
});

describe("mergeSketches — 이번 컷에 해당하는 것만 남긴다", () => {
  it("쓰이지 않게 된 시안은 목록에서 빠진다", () => {
    const current = cut();
    const stale = { key: "deadbeefdeadbeef", url: "https://x/old.jpg" };
    const fresh = { key: cutSketchKey(current), url: "https://x/new.jpg" };
    const merged = mergeSketches([current], [stale], [fresh]);
    expect(merged).toEqual([fresh]);
  });

  it("컷 순서대로 정렬된다", () => {
    const a = cut({ no: "1", subject: "A" });
    const b = cut({ no: "2", subject: "B" });
    const sa = { key: cutSketchKey(a), url: "https://x/a.jpg" };
    const sb = { key: cutSketchKey(b), url: "https://x/b.jpg" };
    expect(mergeSketches([a, b], [], [sb, sa])).toEqual([sa, sb]);
  });
});

describe("parseStoredSketches — 저장값이 깨져도 생성은 계속된다", () => {
  it("정상 JSON 을 읽는다", () => {
    expect(parseStoredSketches('[{"key":"a","url":"https://x/a.jpg"}]')).toEqual([
      { key: "a", url: "https://x/a.jpg" },
    ]);
  });

  it("null·깨진 JSON·비배열은 빈 배열이다(예외를 던지지 않는다)", () => {
    for (const bad of [null, "{{{", '"문자열"', "42"]) {
      expect(parseStoredSketches(bad as string | null)).toEqual([]);
    }
  });

  it("모양이 안 맞는 원소는 걸러낸다", () => {
    expect(parseStoredSketches('[{"key":"a"},{"key":"b","url":"https://x/b.jpg"}]')).toEqual([
      { key: "b", url: "https://x/b.jpg" },
    ]);
  });
});

describe("저장 경로", () => {
  it("컷 키가 경로에 들어가 같은 컷이면 같은 객체를 덮어쓴다", () => {
    const c = cut();
    expect(sketchStoragePath("deal1", cutSketchKey(c))).toBe(
      `deals/deal1/sketches/${cutSketchKey(c)}.jpg`,
    );
  });
});

describe("sketchFrameStatus — 빈 프레임의 세 가지 의미를 가른다", () => {
  // 오너 지적(2026-08-01): 빈 점선 프레임 하나가 "그리는 중"·"실패"·"기능 미작동"을
  // 전부 뜻해서 구분이 안 됐다. 이 판정이 그 구분의 정본이다.
  const p = (over: Partial<SketchProgress> = {}): SketchProgress => ({
    loading: false,
    failures: [],
    skippedKeys: [],
    requestError: null,
    ...over,
  });

  it("그려진 것은 무슨 일이 있어도 ready — 재시도 중에 뒷걸음질치지 않는다", () => {
    expect(sketchFrameStatus("k", true, p({ loading: true }))).toBe("ready");
    expect(sketchFrameStatus("k", true, p({ failures: [{ key: "k", reason: "UNKNOWN" as const }] }))).toBe("ready");
    expect(sketchFrameStatus("k", true, p({ requestError: "FAILED" }))).toBe("ready");
  });

  it("진행 중과 실패를 가른다", () => {
    expect(sketchFrameStatus("k", false, p({ loading: true }))).toBe("loading");
    expect(sketchFrameStatus("k", false, p({ failures: [{ key: "k", reason: "UNKNOWN" as const }] }))).toBe("failed");
  });

  it("같은 응답에서 성공·실패가 섞여도 컷별로 갈린다", () => {
    const progress = p({ failures: [{ key: "b", reason: "UNKNOWN" as const }] });
    expect(sketchFrameStatus("a", true, progress)).toBe("ready");
    expect(sketchFrameStatus("b", false, progress)).toBe("failed");
    expect(sketchFrameStatus("c", false, progress)).toBe("idle");
  });

  it("상한 초과는 실패가 아니다 — 운영자가 할 일이 다르다", () => {
    expect(sketchFrameStatus("k", false, p({ skippedKeys: ["k"] }))).toBe("skipped");
  });

  it("저장소 미설정은 실패와 구분한다 — 재시도해도 소용없는 설정 문제다", () => {
    expect(sketchFrameStatus("k", false, p({ requestError: "UNAVAILABLE" }))).toBe(
      "unavailable",
    );
  });

  it("요청이 통째로 실패하면 URL 없는 프레임 전부가 failed 다", () => {
    const progress = p({ requestError: "FAILED" });
    expect(sketchFrameStatus("a", false, progress)).toBe("failed");
    expect(sketchFrameStatus("b", false, progress)).toBe("failed");
  });

  it("진행 정보가 없으면 idle — 초안 복원 직후의 빈 프레임과 같다", () => {
    expect(sketchFrameStatus("k", false, undefined)).toBe("idle");
    expect(sketchFrameStatus("k", false, p())).toBe("idle");
  });

  it("글자를 쓰는 상태와 안 쓰는 상태가 갈려 있다", () => {
    expect(SKETCH_STATUS_LABEL.ready).toBeNull();
    expect(SKETCH_STATUS_LABEL.loading).toBeNull();
    expect(SKETCH_STATUS_LABEL.idle).toBeNull();
    for (const k of ["failed", "skipped", "unavailable"] as const) {
      expect(SKETCH_STATUS_LABEL[k]).toBeTruthy();
    }
  });
});

describe("classifySketchFailure — 처방이 다른 것끼리 가른다", () => {
  // "시안 생성 실패" 한 줄로는 디버깅이 안 된다(오너 지적 2026-08-01).
  // 운영자가 할 일이 이유마다 다르므로 그 단위로 가른다.
  it("지출 상한과 일시 한도를 가른다 — 전자는 재시도로 안 낫는다", () => {
    const cap = Object.assign(new Error("exceeded its monthly spending cap"), {
      status: 429,
    });
    const burst = Object.assign(new Error("too many requests"), { status: 429 });
    expect(classifySketchFailure("GENERATE", cap)).toBe("SPEND_CAP");
    expect(classifySketchFailure("GENERATE", burst)).toBe("RATE_LIMITED");
  });

  it("status 없이 메시지에 429 만 있어도 잡는다", () => {
    expect(
      classifySketchFailure("GENERATE", new Error("Gemini API 오류 (status=429): quota")),
    ).toBe("SPEND_CAP");
  });

  it("이미지가 안 온 경우는 별도 이유다 — 컷 문구를 손보면 될 수 있다", () => {
    expect(
      classifySketchFailure(
        "GENERATE",
        new Error("Gemini 이미지 응답에 inline 데이터가 없습니다(output_image.data 부재)"),
      ),
    ).toBe("NO_IMAGE");
  });

  it("저장 단계 실패는 오류 문자열과 무관하게 UPLOAD 다 — 인프라 문제다", () => {
    expect(classifySketchFailure("UPLOAD", new Error("429 quota"))).toBe("UPLOAD");
  });

  it("네트워크와 알 수 없음을 가른다", () => {
    expect(classifySketchFailure("GENERATE", new Error("fetch failed"))).toBe("NETWORK");
    expect(classifySketchFailure("GENERATE", new Error("무언가"))).toBe("UNKNOWN");
  });

  it("모든 이유에 처방 라벨이 있다 — 라벨 없는 이유를 만들지 않는다", () => {
    for (const r of [
      "SPEND_CAP", "RATE_LIMITED", "NO_IMAGE", "UPLOAD", "NETWORK", "UNKNOWN",
    ] as const) {
      expect(SKETCH_FAILURE_LABEL[r]).toBeTruthy();
    }
  });

  it("⛔ 라벨에 원문 오류를 싣지 않는다 — 본문에 요청 URL(키)이 에코될 수 있다(P0)", () => {
    for (const label of Object.values(SKETCH_FAILURE_LABEL)) {
      expect(label).not.toMatch(/key=|AIza|https?:\/\//);
    }
  });
});

describe("sketchFrameLabel — 아는 실패는 이유까지 쓴다", () => {
  const p = (over: Partial<SketchProgress> = {}): SketchProgress => ({
    loading: false, failures: [], skippedKeys: [], requestError: null, ...over,
  });

  it("이유를 아는 실패는 처방 라벨을 쓴다", () => {
    const progress = p({ failures: [{ key: "k", reason: "SPEND_CAP" }] });
    expect(sketchFrameLabel("k", "failed", progress)).toBe(
      SKETCH_FAILURE_LABEL.SPEND_CAP,
    );
  });

  it("요청이 통째로 실패해 키를 모르면 일반 문구로 떨어진다", () => {
    expect(sketchFrameLabel("k", "failed", p({ requestError: "FAILED" }))).toBe(
      SKETCH_STATUS_LABEL.failed,
    );
  });

  it("실패가 아닌 상태는 기존 라벨 그대로다", () => {
    expect(sketchFrameLabel("k", "loading", p())).toBeNull();
    expect(sketchFrameLabel("k", "unavailable", p())).toBe(
      SKETCH_STATUS_LABEL.unavailable,
    );
  });
});

describe("classifySketchFailure — 400 은 재시도가 무의미한 배선 문제다", () => {
  // 실사고 2026-08-01: `delivery:"inline"` 이 SDK 타입엔 있는데 서버가 400 으로
  // 거부해 전 컷이 죽었다. 그때 이 분류가 없어 UNKNOWN 으로 떨어졌고, 화면이
  // "시안 생성 실패"만 써서 처방이 안 나왔다.
  it("400 을 UNKNOWN 이 아니라 BAD_REQUEST 로 가른다", () => {
    const err = Object.assign(new Error("Image delivery mode is not supported."), {
      status: 400,
    });
    expect(classifySketchFailure("GENERATE", err)).toBe("BAD_REQUEST");
  });

  it("status 없이 메시지에 400 만 있어도 잡는다", () => {
    expect(
      classifySketchFailure("GENERATE", new Error("400 Image delivery mode is not supported.")),
    ).toBe("BAD_REQUEST");
  });

  it("라벨이 '재시도'가 아니라 '배선 확인'을 가리킨다 — 처방이 다르다", () => {
    expect(SKETCH_FAILURE_LABEL.BAD_REQUEST).toMatch(/배선|형식/);
    expect(SKETCH_FAILURE_LABEL.BAD_REQUEST).not.toMatch(/잠시 후|다시/);
  });
});

describe("요청 실패를 무음으로 삼키지 않는다 (P0)", () => {
  /**
   * 종전 구현은 응답이 실패해도 그냥 `return` 해서, 빈 프레임이 **"그리는 중"인지
   * "실패"인지 구분되지 않았다**(오너 지적으로 고쳐진 건). 화면은 로딩과 실패를
   * 같은 그림으로 보여주고 있었고, 운영자는 기다리면 되는 줄 알았다.
   *
   * 이 규칙은 그동안 주석으로만 서 있었고, 2026-08-07 딜 패널 분할 때 그 주석이
   * 실제로 사라졌다(코드는 살아남았다). 그래서 계약으로 승격한다 — 다음에 분기가
   * 지워지면 이 테스트가 먼저 깨진다.
   */
  const WIRING = readFileSync(
    join(process.cwd(), "src/hooks/useDealAssets.ts"),
    "utf8",
  );

  it("응답 실패 분기가 상태를 세운다 — 맨 return 으로 빠지지 않는다", () => {
    // ⚠️ `setSketchRequestError(` 존재만 보면 **공허 통과**다 — useState 선언과 catch
    //    블록에도 같은 이름이 있어 `!res.ok` 분기를 통째로 비워도 통과한다(작성 중
    //    변이 프로브로 실측). 그래서 그 분기 **안**을 본다.
    expect(WIRING).toMatch(/if \(!res\.ok\) \{\s*setSketchRequestError\(/);
  });

  it("503(저장소 미설정)과 그 외 실패를 가른다 — 재시도 안내가 달라진다", () => {
    // 503 은 재시도해도 소용없다. 같은 문구로 묶으면 운영자가 헛되이 다시 누른다.
    expect(WIRING).toMatch(/setSketchRequestError\([^)]*503[^)]*UNAVAILABLE[^)]*FAILED/);
  });
});
