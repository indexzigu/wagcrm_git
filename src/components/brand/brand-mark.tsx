import { cn } from "@/lib/utils";

/**
 * WAG CRM 브랜드 마크 — 말풍선 + 내부 막대그래프.
 *
 * 브랜드 킷 확정본(`brand_logos/final/wagcrm-icon.svg`, 시안 C1)의 인라인 판이다.
 * 원본이 그렇듯 **단색**이다 — 말풍선도 막대도 전부 `currentColor` 라서 부모의 `text-*`
 * 하나로 색이 결정된다. 그래서 표면을 옮길 때 이 컴포넌트를 고칠 일이 없다.
 *
 * `<img>` 가 아니라 인라인 SVG 인 이유가 이것이다 — 사이드바(네이비)·설치 게이트·로그인처럼
 * 배경이 다른 자리에 한 컴포넌트로 얹히려면 색을 상속받아야 한다.
 *
 * ⚠️ 색은 **표면 종속**이다(P8 §5). 골드 #E7A567 는 네이비 계열 위에서만 쓴다 —
 * 흰 배경 위 2.11:1 로 미달이라, 밝은 화면에서는 마크를 네이비 칩 안에 넣어 얹는다
 * (`landing-login-branding.tsx` 가 그 형태다).
 *
 * 파비콘·PWA 아이콘(`src/app/icon.svg`, `public/icon-*.png`)은 OS 가 읽는 별도 표면이라
 * 타일이 포함된 자체 파일을 쓴다 — 그쪽을 이 컴포넌트로 대체하지 말 것. 도형을 고칠 일이
 * 생기면 이 파일이 아니라 브랜드 킷을 먼저 고치고(`export_wagcrm_navygold.py` 재생성)
 * 그 결과를 여기로 옮긴다 — 아이콘과 갈라지면 안 된다.
 */
export function BrandMark({
  className,
  title,
}: {
  className?: string;
  /** 접근성 이름. 생략하면 장식으로 간주해 스크린리더에서 감춘다. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        d="M28 20 H72 A12 12 0 0 1 84 32 V52 A12 12 0 0 1 72 64 H42 L26 78 V64 A12 12 0 0 1 16 52 V32 A12 12 0 0 1 28 20 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="6.5"
        strokeLinejoin="round"
      />
      <g fill="currentColor">
        <rect x="35" y="44" width="7" height="10" rx="2" />
        <rect x="46" y="37" width="7" height="17" rx="2" />
        <rect x="57" y="30" width="7" height="24" rx="2" />
      </g>
    </svg>
  );
}
