"use client";

import {
  PROOF_CARD_HEADER,
  parseGuideSections,
  DEFAULT_GUIDE_KIND,
  type GuideCut,
  type GuideKind,
  type GuideRenderLine,
  type GuideRenderSection,
} from "@/lib/content-guide";
import {
  cutSketchKey,
  sketchFrameStatus,
  sketchFrameLabel,
  type GuideSketch,
  type SketchProgress,
} from "@/lib/guide-sketch";
import { Skeleton } from "@/components/ui/skeleton";

/** `## 근거 카드` 에서 헤더 기호를 뗀 제목 — 파서가 돌려주는 형태와 맞춘다. */
const PROOF_CARD_TITLE = PROOF_CARD_HEADER.replace(/^#{2,3}\s+/, "");

function InlineSpans({ line }: { line: GuideRenderLine }) {
  return (
    <>
      {line.spans.map((span, i) =>
        span.strong ? (
          <strong key={i} className="font-medium text-foreground">
            {span.text}
          </strong>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </>
  );
}

/**
 * 촬영 컷 시안 — "어떤 그림이 필요한가"를 프레임으로 세운다.
 *
 * 가이드는 원래도 무엇을 찍어야 하는지를 쓰고 있었지만 `## 포맷 추천` 산문에
 * 뭉쳐 있어 컷 단위로 읽히지 않았다. 번호와 자리(0~3초 / 첫 장)를 프레임 위에,
 * 피사체를 프레임 안에, 이 컷이 하는 일을 프레임 아래 캡션에 둔다 — 셀러는 위에서
 * 아래로 읽으며 그대로 찍는다.
 *
 * 시안(`sketchByKey`)이 있으면 프레임을 **구도 스케치**로 채운다. ⚠️ 그 그림은
 * **제품 사진이 아니다** — 흑백 선화·구도 전용으로 프롬프트가 못박혀 있다
 * (`SKETCH_STYLE_LOCK`). 실물과 다른 제품 이미지는 셀러에게 잘못된 기준을 주고
 * 표시광고 측면에서도 근거 없는 시각 주장이 된다. 스타일 락을 풀지 말 것.
 *
 * 시안이 없으면(생성 전·실패·저장소 미설정) **지금까지의 빈 점선 프레임 그대로**다 —
 * 점진적 향상이라 이미지 경로가 죽어도 기능이 깨지지 않는다.
 */
function CutFrames({
  cuts,
  kind,
  sketchByKey,
  progress,
}: {
  cuts: GuideCut[];
  /** 시안 캐시 키의 네임스페이스. 유형이 다르면 같은 컷도 다른 그림이다. */
  kind: GuideKind;
  sketchByKey?: Map<string, string>;
  progress?: SketchProgress;
}) {
  return (
    <ol className="mt-1.5 grid grid-cols-2 gap-2">
      {cuts.map((cut, i) => {
        const key = cutSketchKey(cut, kind);
        const url = sketchByKey?.get(key);
        const status = sketchFrameStatus(key, Boolean(url), progress);
        const label = sketchFrameLabel(key, status, progress);
        return (
        <li key={i}>
          {/* 4:5 — 특정 플랫폼 비율을 주장하지 않으면서 "프레임"으로 읽히는 최소 형태.
              점선은 "아직 안 찍은 자리"라는 뜻이다(채워진 상자는 완성물로 읽힌다).

              ⚠️ **3열로 되돌리지 말 것.** 380px 카드에서 3열은 프레임 하나가 ~115px 라
              피사체 문장이 두세 단어만 길어져도 상자 안이 빡빡해지고, 글자를 줄여
              맞추다 `text-[9px]` 로 내려가 P8 「데이터 그리드 3단 사다리」의 이탈값
              (9px·11px)을 새로 들이게 된다. 2열이면 사다리 안(12px 본문 / 10px
              서브라벨)에서 프레임이 성립한다. */}
          <div className="relative flex aspect-4/5 flex-col overflow-hidden rounded-md border border-dashed border-slate-300 bg-background p-2">
            {status === "loading" ? (
              // 스켈레톤은 프레임을 꽉 채운다 — 스피너를 쓰지 않는다(styleseed
              // 기계 점검 §3: 최종 레이아웃 모양의 스켈레톤). 컷 글자는 그대로
              // 위에 남겨 "무엇을 그리는 중인지" 읽히게 한다.
              <Skeleton className="absolute inset-0 size-full rounded-none" />
            ) : null}
            {url ? (
              <>
                {/* 스케치는 9:16 으로 뽑고 프레임은 4:5 라 `object-cover` 로 가운데를
                    보여준다. 구도 확인이 목적이라 잘려도 무방하다. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 size-full object-cover"
                />
                {/* 그림 위 글자는 스크림 없이는 읽히지 않는다 — 흰 선화라 밝은 면이 많다. */}
                <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/55 to-transparent p-2">
                  <p className="text-[10px] font-medium text-white">
                    C{cut.no} · {cut.slot}
                  </p>
                  <p className="mt-1 text-xs leading-snug text-white">
                    {cut.subject}
                  </p>
                </div>
              </>
            ) : (
              <>
                <p className="relative text-[10px] font-medium text-muted-foreground">
                  C{cut.no} · {cut.slot}
                </p>
                <p className="relative mt-1 text-xs leading-snug text-foreground">
                  {cut.subject}
                </p>
                {/* 실패·미생성·기능오프를 글자로 가른다. 색은 쓰지 않는다 —
                    시안은 부가 기능이고 초안 자체는 멀쩡하므로 심각도 축(P8 §1)에
                    올릴 사안이 아니다. "주의가 필요한 소수에만 색"의 기준으로도
                    검수를 막는 문제가 아니다. */}
                {label ? (
                  <p className="relative mt-auto text-[10px] leading-snug text-muted-foreground">
                    {label}
                  </p>
                ) : null}
              </>
            )}
          </div>
          {cut.why ? (
            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
              {cut.why}
            </p>
          ) : null}
        </li>
        );
      })}
    </ol>
  );
}

/**
 * 줄의 종류 — 컷 시안 / 목록 / 산문. 셋을 서로 다른 요소로 낸다.
 *
 * ⚠️ 한 `<ul>` 안에 산문 줄을 `list-none` `<li>` 로 섞지 않는다 — 스크린리더가
 * "목록, N개 항목"으로 안내하고 산문까지 "목록 항목"으로 읽어 WCAG 1.3.1(정보와
 * 관계)과 어긋난다(ss-ux-designer P1 지적, 2026-08-01). 목록은 `<ul>`, 산문은
 * `<p>`, 컷은 `<ol>` 프레임으로 갈라서 낸다.
 */
type LineKind = "cut" | "bullet" | "prose";

function lineKind(line: GuideRenderLine): LineKind {
  if (line.cut) return "cut";
  return line.bullet ? "bullet" : "prose";
}

/** 같은 종류가 **연속된 구간(run)** 끼리 묶는다. */
function groupLines(lines: GuideRenderLine[]): GuideRenderLine[][] {
  const runs: GuideRenderLine[][] = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && lineKind(last[0]) === lineKind(line)) last.push(line);
    else runs.push([line]);
  }
  return runs;
}

function GuideSection({
  section,
  kind,
  sketchByKey,
  progress,
}: {
  section: GuideRenderSection;
  kind: GuideKind;
  sketchByKey?: Map<string, string>;
  progress?: SketchProgress;
}) {
  return (
    <>
      {section.title ? (
        <p className="text-xs font-semibold text-muted-foreground">
          {section.title}
        </p>
      ) : null}
      <div className="mt-1 space-y-1 text-xs leading-relaxed text-foreground">
        {groupLines(section.lines).map((run, i) => {
          // `kind`(가이드 유형)와 이름이 겹치지 않게 `runKind` 로 둔다 — 겹치면
          // 안쪽이 바깥을 가려 컷 프레임에 줄 종류가 유형으로 넘어간다.
          const runKind = lineKind(run[0]);
          if (runKind === "cut") {
            return (
              <CutFrames
                key={i}
                cuts={run.map((line) => line.cut!)}
                kind={kind}
                sketchByKey={sketchByKey}
                progress={progress}
              />
            );
          }
          if (runKind === "bullet") {
            return (
              <ul key={i} className="space-y-0.5 pl-4">
                {run.map((line, j) => (
                  <li key={j} className="list-disc marker:text-slate-400">
                    <InlineSpans line={line} />
                  </li>
                ))}
              </ul>
            );
          }
          return run.map((line, j) => (
            <p key={`${i}-${j}`}>
              <InlineSpans line={line} />
            </p>
          ));
        })}
      </div>
    </>
  );
}

/**
 * 생성된 콘텐츠 가이드 초안의 **표시 계층**.
 *
 * 운영자가 이 카드에서 내리는 판단은 "이 초안을 셀러에게 보내도 되는가" 하나다
 * (P2 Workflow Goal First). 그래서 6~7개 섹션을 훑을 수 있게 제목·항목 구조를
 * 살리고, 마크다운 기호(`##`·`-`·`**`)는 화면에서 걷어낸다 — 기호는 카톡에
 * 붙여넣을 원문에만 필요하지 검수하는 눈에는 잡음이다.
 *
 * ⚠️ **원문은 그대로 둔다.** 복사 버튼은 이 컴포넌트를 거치지 않고 마크다운
 * 원문을 복사하고, 표현 검사도 원문을 본다. 여기서 문자열을 가공해 저장하거나
 * 되돌려 주지 않는다.
 *
 * ⛔ **카드 안에 `max-h + overflow-y-auto` 나 접기를 넣지 말 것.** 이 카드가 놓인
 * Sheet 가 이미 자체 스크롤러라 스크롤-인-스크롤이 되고, 접기는 검수해야 할
 * 전문을 기본값으로 숨긴다. 둘 다 이 컴포넌트의 목적과 정면으로 충돌한다
 * (ss-ux-designer 판정, 2026-08-01 — 제안이 다시 들어오면 이 줄이 기각 근거다).
 *
 * 섹션 구분은 **여백 + 무채색 헤어라인**이 한다(색·상자 아님) — 이 카드 자체가
 * 이미 옅은 네이비 틴트라 안에 또 테두리 상자를 겹치면 카드-인-카드가 되고,
 * 섹션은 좋고 나쁨이 없는 **범주**라 색을 받지 않는다(P8 §4). 헤어라인은 P8
 * 「구분선 2단」의 섹션 경계(`border-slate-200/60`)를 그대로 쓴다.
 * 예외는 근거 카드 하나 — 모델 생성물이 아니라 코드가 DB 값으로 조립한
 * "셀러가 인용해도 되는 사실"이라 출처가 다르다. 그 구분도 색이 아니라
 * **표면**(무채색 인셋)으로 하며, 같은 카드의 자유 생성·근거 부재 안내가
 * 이미 쓰는 언어를 재사용한다.
 */
export function ContentGuideView({
  guide,
  kind = DEFAULT_GUIDE_KIND,
  sketches,
  sketchProgress,
}: {
  guide: string;
  /**
   * 이 초안의 가이드 유형. **시안 조회 키에 들어간다** — 넘기지 않으면 브랜드형
   * 프레임이 셀러형 키로 조회돼 전부 빈 상태가 된다(오류 없이 조용히).
   */
  kind?: GuideKind;
  /** 저장된 촬영 컷 시안. 없으면 프레임이 빈 상태로 남는다(점진적 향상). */
  sketches?: GuideSketch[];
  /**
   * 시안 진행 상황. 없으면 모든 빈 프레임이 `idle`(지금까지의 빈 프레임)이다.
   * 있으면 프레임마다 생성 중·실패·미생성·기능오프를 가려 보여준다.
   */
  sketchProgress?: SketchProgress;
}) {
  const sections = parseGuideSections(guide);
  const sketchByKey = sketches?.length
    ? new Map(sketches.map((s) => [s.key, s.url]))
    : undefined;

  // 파싱이 아무것도 못 건졌다면 원문을 그대로 보여준다 — 검수용 초안이라
  // "안 보이는 구간"이 생기는 쪽이 못생긴 마크다운보다 훨씬 나쁘다.
  if (sections.length === 0) {
    return (
      <p className="mt-2 whitespace-pre-wrap text-xs text-foreground">{guide}</p>
    );
  }

  return (
    <div className="mt-2">
      {sections.map((section, i) => {
        if (section.title === PROOF_CARD_TITLE) {
          return (
            <div
              key={i}
              className="mt-3 rounded-md border border-input bg-background px-2 py-1.5"
            >
              <GuideSection
                section={section}
                kind={kind}
                sketchByKey={sketchByKey}
                progress={sketchProgress}
              />
            </div>
          );
        }
        return (
          <div
            key={i}
            className={
              i === 0 ? undefined : "mt-3 border-t border-slate-200/60 pt-3"
            }
          >
            <GuideSection
                section={section}
                kind={kind}
                sketchByKey={sketchByKey}
                progress={sketchProgress}
              />
          </div>
        );
      })}
    </div>
  );
}
