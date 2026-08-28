import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Au79 CRM",
    short_name: "Au79 CRM",
    description: "CRM workspace",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // PWA 스플래시 캔버스. 브랜드 아이콘의 **타일 배경색**과 같은 값이어야 하고, 그 타일이
    // --primary 네이비라 결과적으로 --primary 와 같다. 캔버스 중앙에 얹히는 purpose:"any"
    // 아이콘은 모서리가 투명한 라운드 타일(rx 22/100)이라, 이 값이 어긋나면 타일 둘레의
    // 라운드 모서리로 다른 색이 비쳐 색 경계(솔기)가 보인다.
    // ⚠️ 기준은 "--primary 와 같게"가 아니라 **"아이콘 타일과 같게"** 다 — 로고 검토 중
    // 잉크(#1A1A1A) 타일 안을 잠시 거쳤고 그때는 이 값도 잉크여야 했다. 아이콘 타일 색을
    // 바꾸면 --primary 와 무관하게 이 값도 함께 갱신할 것.
    //
    // hex 하드코딩은 P8 "hex 금지, 토큰 사용" 의 예외가 아니라 그 규칙이 닿지 않는
    // 표면이다: manifest 는 빌드 시 JSON 으로 직렬화되어 CSS 컨텍스트 밖에서 OS 가
    // 읽으므로 var(--primary) 를 해석할 주체가 없다(파비콘 SVG 와 같은 이유).
    background_color: "#0A3D62",
    // theme_color 는 브라우저/OS 크롬 색이라 background_color 와 역할이 다르다 —
    // 의도적으로 #080B11 을 유지한다. 이 값은 mobile-standalone-gate.tsx 의
    // bg-[#080B11] 과 맞물려 있어(설치 전 안내 화면), 네이비로 바꾸면 그 화면에서
    // 툴바만 네이비가 되어 새 솔기가 생긴다(오너 확정 2026-07-16).
    // 바꾸려면 게이트 배경도 함께 옮겨야 하고, 그 화면의 WAG 배지가 bg-primary 라
    // 배경과 같은 네이비가 되면 묻힌다 — 배지 색 재설계가 선행되어야 한다.
    theme_color: "#080B11",
    orientation: "portrait",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // maskable은 같은 아트의 복사본이 아니다. Android가 바깥 20%를 잘라내므로
        // 같은 배율을 쓰면 잘린 창 안에서 심볼이 더 크게 보인다. 브랜드 번들도 같은
        // 원리로 심볼을 줄여 배포한다 — 실측 심볼 폭 any 66.8% vs maskable 52.0%
        // (비율 0.78 ≈ 410/512), 안전영역 80% 이내. 또한 any 는 모서리가 투명한
        // 라운드 타일이지만 maskable 은 잉크로 전면을 채운다(마스크가 모서리를 만든다).
        // 재생성 시 export_apply.py 가 이 두 배율을 관리하므로 여기서 스케일을
        // 손보지 말 것.
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
