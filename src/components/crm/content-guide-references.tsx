"use client";

import { Play } from "lucide-react";

import type { GuideReferenceCard } from "@/lib/content-guide";

export type { GuideReferenceCard };

/** 크론(`enrich-references`)이 채우는 값 중 움직이는 매체 — 재생 마커를 붙인다. */
const MOTION_MEDIA = new Set(["video", "reel"]);

/**
 * 이 미만이면 "레퍼런스가 얕다"고 알린다.
 *
 * ⚠️ **표시 휴리스틱이지 계약이 아니다.** 몇 건부터 방향이 설 만한지는 실무
 * 감각의 문제라 오너가 바꿀 값이다(상한 `MAX_GUIDE_REFERENCES`=12 와 다른 축).
 * 왜 알리나: 레퍼런스 유입은 전부 수동이라(인박스 `MANUAL|KAKAO`, 키워드 자동
 * 수집 경로 없음) 얕은 상태가 저절로 해소되지 않는다. 얕다는 사실을 숨기면
 * 운영자는 딜 정보만으로 쓰인 초안을 레퍼런스 기반 초안과 구별하지 못한다.
 */
const SHALLOW_REFERENCE_THRESHOLD = 3;

/** 얕은 입력을 알리는 무채색 인셋 — 심각도가 아니라 "생성 조건"이다(P8 §4). */
function ShallowNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function tileLabel(ref: GuideReferenceCard): string {
  const likes =
    ref.likes !== null ? ` · 좋아요 ${ref.likes.toLocaleString("ko-KR")}` : "";
  return `${ref.name}${likes}`;
}

/**
 * 가이드 생성에 **실제로 들어간** SNS 레퍼런스 스트립.
 *
 * 왜 필요한가(P2 Decision-Value Priority): 카드는 "참고 레퍼런스 4건 반영"이라는
 * **숫자**만 말하고 그 4건이 무엇인지는 말하지 않았다. 운영자가 "①문제 제기 훅"의
 * 방향이 타당한지 보려면 무엇을 보고 나온 훅인지 알아야 하는데, 그러려면 눈을
 * 자산 목록으로 옮겨 링크를 눌러 인스타로 나가야 했다. 숫자와 그 숫자가 세는
 * 것을 붙여 둔다.
 *
 * ⚠️ **여기 보이는 목록은 모델에 들어간 것과 정확히 같아야 한다** — 라우트가
 * 정렬·절단을 `rankGuideReferences` 한 함수에 맡기는 이유다. 어긋나면 검수 재료가
 * 아니라 오해의 근원이 된다.
 *
 * 자산 목록(위쪽 "첨부 자료")과 겹쳐 보이지만 다른 것이다: 저쪽은 딜의 **모든**
 * 첨부(계약서·가격표 포함)를 32px 파일 행으로 세우고, 여기는 **이번 생성에 쓰인**
 * 레퍼런스만 좋아요 순으로, 구도가 보이는 크기로 세운다.
 *
 * 생성 이미지를 쓰지 않는 이유: 이 자리의 그림은 셀러 지시서가 아니라 운영자의
 * 검수 재료다. 실물 레퍼런스는 가이드의 **입력**이라 추적 가치가 있지만, 생성
 * 이미지는 모델이 자기 출력을 그림으로 옮긴 것이라 검증 가치가 구조적으로 0이고
 * "그림이 그럴듯하니 텍스트도 맞겠지"라는 잘못된 확신만 준다.
 */
export function ContentGuideReferences({
  references,
}: {
  references: GuideReferenceCard[];
}) {
  // 0건은 숨기지 않고 말한다 — 입력이 빈약하다는 사실 자체가 운영자에게 필요한
  // 신호다(레퍼런스를 등록하라). "위 URL 입력"은 이 카드 바로 위에 이미 있는
  // 레퍼런스 추가 입력을 가리킨다 — 새 표면을 만들지 않고 있는 길로 보낸다.
  if (references.length === 0) {
    return (
      <ShallowNotice>
        참고 레퍼런스 없이 딜 정보만으로 작성했습니다. 위 URL 입력으로 이 딜에
        SNS 레퍼런스를 등록하면 다음 생성부터 그 방향을 반영합니다.
      </ShallowNotice>
    );
  }

  return (
    <div className="mt-2">
      <p className="text-[10px] text-muted-foreground">
        이 초안이 참고한 레퍼런스 · 좋아요 순
      </p>
      <ul className="mt-1 grid grid-cols-6 gap-1.5">
        {references.map((ref, i) => {
          const label = tileLabel(ref);
          const tile = (
            <>
              {ref.thumbnailUrl ? (
                // 크론이 우리 스토리지로 재호스팅한 썸네일. next/image 를 쓰지 않는
                // 이유는 자산 목록과 같다 — 호스트가 런타임에 정해져 원격 패턴을
                // 고정할 수 없다.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={ref.thumbnailUrl}
                  alt={label}
                  loading="lazy"
                  className="size-full rounded-md object-cover"
                />
              ) : (
                // 썸네일 수집 전이거나 실패한 건 — 자리를 비우지 않는다. 목록에서
                // 빠지면 "모델이 안 썼다"로 오해된다(실제로는 캡션으로 쓰였다).
                <span className="flex size-full items-center justify-center rounded-md bg-slate-100 px-1 text-center text-[9px] leading-tight text-slate-500">
                  {ref.name}
                </span>
              )}
              {MOTION_MEDIA.has(ref.mediaType ?? "") ? (
                // 스크림 위 흰 아이콘 — 사진 위 저대비 고스트를 피한다. 매체 종류는
                // 좋고 나쁨이 없는 범주라 상태 hue 를 받지 않는다(P8 §4).
                <span className="absolute bottom-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-black/55">
                  <Play className="size-2 fill-white text-white" />
                </span>
              ) : null}
            </>
          );

          return (
            <li key={i} className="relative aspect-square">
              {ref.externalUrl ? (
                <a
                  href={ref.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={label}
                  className="block size-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {tile}
                </a>
              ) : (
                <span title={label} className="block size-full">
                  {tile}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {references.length < SHALLOW_REFERENCE_THRESHOLD ? (
        <ShallowNotice>
          레퍼런스가 {references.length}건뿐이라 훅·포맷 방향이 딜 정보에 크게
          기댔습니다. 위 URL 입력으로 비슷한 결의 게시물을 몇 개 더 넣고 다시
          생성하면 방향이 또렷해집니다.
        </ShallowNotice>
      ) : null}
    </div>
  );
}
