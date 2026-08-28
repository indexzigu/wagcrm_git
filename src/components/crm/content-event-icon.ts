// 콘텐츠 유형의 아이콘·라벨 — 일별 차트와 인트라데이 차트가 공유한다.
//
// 두 곳에 따로 두면 마커가 말하는 유형이 갈라진다(실제로 인트라데이 마커가 아이콘 없이
// 빈 원으로 나가 있었다). 유형은 **좋고 나쁨이 없는 범주**라 색을 받지 않고 아이콘 모양과
// 스크린리더용 텍스트로만 구분한다(P8 §4).
import { CircleDashed, CircleHelp, Clapperboard, Image as ImageIcon, Images, Video } from "lucide-react";

import type { ContentEventType } from "@/lib/content-order-correlation";

/** 아이콘은 장식(aria-hidden)일 뿐 — 접근 가능 이름은 EVENT_TYPE_LABEL 이 담당한다. */
export const EVENT_ICON: Record<ContentEventType, typeof ImageIcon> = {
  story: CircleDashed,
  reel: Clapperboard,
  video: Video,
  image: ImageIcon,
  unknown: CircleHelp,
  carousel: Images,
};

/** 스크린리더 전용 유형 라벨 — 6종 전체. 색 대신 텍스트로 범주를 구분한다. */
export const EVENT_TYPE_LABEL: Record<ContentEventType, string> = {
  story: "스토리",
  reel: "릴스",
  video: "영상",
  image: "사진",
  carousel: "여러 장",
  unknown: "기타",
};
