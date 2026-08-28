"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BriefcaseIcon,
  Building2Icon,
  CalendarDaysIcon,
  FolderIcon,
  GaugeIcon,
  MegaphoneIcon,
  PackageIcon,
  Settings2Icon,
  ShieldCheckIcon,
  Table2Icon,
  UserRoundIcon,
  LogOutIcon,
  Link2Icon,
  TrendingUpIcon,
  EyeIcon,
  EyeOffIcon,
  SparklesIcon,
  WalletIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebarPeek,
} from "@/components/ui/sidebar";
import { BrandMark } from "@/components/brand/brand-mark";
import { usePrivacyMode } from "@/components/crm/privacy-mode-provider";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isClientDemoMode } from "@/lib/demo-mode";
import { Badge } from "@/components/ui/badge";
import { useApprovalInbox } from "@/hooks/useApprovalInbox";
import { useUserRole } from "@/hooks/use-user-role";

// 섹션 그룹핑 — 묶음은 성격(진행 / 리포트 / 기본정보 / 도구), 진행 그룹의
// 순서는 업무 흐름(영업 → 판매 → 주문 → 정산)이다. 항목 이름에 이미 단계가
// 들어 있어 별도 단계 라벨 없이 연속 4줄이 퍼널을 그대로 보여준다.
// ⛔ 종전 원칙 "묶음=도메인·순서=사용 빈도"(#286)는 SUPERSEDED (2026-08-15 오너
// 재검토) — 빈도 정렬이 흐름을 끊어(집행 단계가 아웃리치보다 위) 영업-판매-정산
// 연결이 구조에 보이지 않았다. 빈도는 근육기억이 흡수하지만 끊긴 흐름은 매번
// 인지 비용을 낸다. 근거 정본: docs/private/specs/2026-08-15-sidebar-ia-redesign-design.md
//
// 첫 그룹은 무라벨(대시보드·캘린더) — "개요" 라벨이 내용을 설명하지 못한다는
// 오너 판단. 무라벨 그룹은 첫 그룹 1개만 허용(계약 테스트 강제).
//
// 아이콘 판정 기준은 "이 화면을 잘 표현하는가"가 아니라 **접힘 모드에서 14개가 한 줄로
// 섰을 때 서로 헷갈리지 않는가**이다(collapsible="icon" 이면 폭 3rem·라벨 소멸·섹션
// 라벨도 구분선으로 바뀌어 아이콘이 유일 단서가 된다. 툴팁은 hover 해야 떠서 스캔에
// 쓸모없다). 2026-08-18 실측 교체 3건(오너 승인, 근거 정본:
// docs/private/specs/2026-08-18-sidebar-icon-collapsed-legibility-design.md):
//   · 주문 관리 FileText → Package — ⛔ FileText 로 되돌리지 말 것. 인접한 정산의
//     ReceiptText 와 18px 실루엣이 사실상 같았다("세로 직사각형 + 가로 3줄", 톱니는
//     1px 미만이라 소멸). 이 레일에서 Package 는 유일한 등각 입체라 겹칠 계열이 없다.
//   · 대시보드 BarChart3 → Gauge — 헤더 브랜드 마크가 말풍선+막대그래프라 바로 아래
//     첫 항목이 또 막대였다. 덤으로 BarChart3Icon 은 lucide 1.x 의 deprecated alias
//     였다(실제 렌더는 ChartColumn) — 아래 계약 테스트가 alias 재유입을 막는다.
//     ⛔ layout-dashboard 는 기각됐다 — 18px 에서 Table2(판매 관리)와 둘 다 격자다.
//   · 정산 관리 ReceiptText → Wallet — 모바일 정산 카드·빠른 정산 모달이 이미 Wallet
//     을 쓰고, ReceiptText 는 /assets 가격표 카드에도 쓰여 정산 전용 신호가 아니었다.
// 바꾸지 않은 것에도 근거가 있다 — Table2(판매 관리)=모바일 하단탭 "캠페인",
// Link2(유입)=유입 리포트 페이지 본문, Briefcase(판매 조건)=글로벌 검색의 딜 결과가
// 각각 같은 아이콘을 쓴다. 데스크톱만 바꾸면 표면이 갈린다.
//
// 섹션 라벨 문구도 같은 날 함께 정정했다(오너 승인). ⛔ 「핵심 업무」·「기준정보」로
// 되돌리지 말 것 — 그 둘은 #408 의 오너 확정 사항이 **아니었다.** §2 가 확정한 것은
// "거래처·셀러·판매 조건·자료 목록은 한 묶음" 이라는 묶음이고, 이름은 그 문장을
// 서술하던 에이전트의 단어가 §3 표에 굳은 것이다.
//   · 핵심 업무 → 진행 — 나머지 셋(리포트·기본정보·도구)이 "안에 뭐가 있는가"인데
//     이것만 "얼마나 중요한가"라 축이 혼자 달랐고, 여집합("비핵심 업무")이 사실이
//     아니다. 위치가 이미 "여기부터"를 말하므로 중복이기도 했다.
//   · 기준정보 → 기본정보 — ERP 표준 용어가 아니라 업계 관용어다(제도권 앵커인
//     ERP정보관리사의 정식 과목명이 「기본정보관리」다). 이 제품 사용자는 ERP 경험이
//     없는 1인 운영자다. ⛔ 자료 목록을 다른 그룹으로 옮기지 말 것 — 넷을 한 묶음으로
//     두는 것은 오너 확정이다(이름만 정직하게 바꾼다).
//   · SidebarGroupLabel 의 uppercase 제거 + tracking-wider → tracking-normal —
//     ⛔ uppercase 를 되살리지 말 것. 섹션 라벨 넷이 전부 순한글이라 text-transform 이
//     렌더에 아무 영향이 없는 죽은 선언이고(#409 의 no-scrollbar 와 같은 종),
//     uppercase+tracking-wider 는 라틴 키커 관용구 한 쌍인데 대문자 쪽이 무효라
//     자간만 남아 10px 한글의 낱말 응집을 깼다. 대비는 4.91:1 로 AA 충족이니 색은 불변.
//
// 섹션 라벨 행은 접힘/펼침 양쪽에서 같은 h-8 슬롯을 차지한다(접힘=가운데
// 구분선) — shadcn 기본값(-mt-8·opacity-0)은 투명 라벨이 위 항목의 클릭을
// 가로채고 아이콘 위치도 상태 간에 밀리게 해서 쓰지 않는다.
export const navSections: {
  label?: string;
  items: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; description: string }[];
}[] = [
  {
    items: [
      { href: "/", label: "대시보드", icon: GaugeIcon, description: "세일즈 진행상황과 운영 리스크 요약" },
      { href: "/calendar", label: "캘린더", icon: CalendarDaysIcon, description: "캠페인 일정 및 입금/출금 예정일 캘린더" },
    ],
  },
  {
    label: "진행",
    items: [
      { href: "/outreach", label: "영업 관리", icon: MegaphoneIcon, description: "영업 활동 및 리마인드 트래킹" },
      { href: "/pipeline", label: "판매 관리", icon: Table2Icon, description: "활성 캠페인 및 파이프라인 현황" },
      { href: "/order-converter", label: "주문 관리", icon: PackageIcon, description: "발주서 변환 및 주문 자동화 처리" },
      { href: "/settlement", label: "정산 관리", icon: WalletIcon, description: "정산 대기 및 처리 내역" },
    ],
  },
  {
    label: "리포트",
    items: [
      { href: "/reports/pnl", label: "손익 리포트", icon: TrendingUpIcon, description: "월별/셀러별/브랜드별 손익 리포트" },
      { href: "/reports/inflow", label: "유입 리포트", icon: Link2Icon, description: "셀러 단축링크의 유입경로·기기·콘텐츠별 클릭" },
    ],
  },
  {
    label: "기본정보",
    items: [
      { href: "/partners", label: "거래처", icon: Building2Icon, description: "협력사 및 거래처 관리" },
      { href: "/sellers", label: "셀러", icon: UserRoundIcon, description: "셀러 인플루언서 관리" },
      { href: "/deals", label: "판매 조건 관리", icon: BriefcaseIcon, description: "진행 중인 딜 리스트" },
      { href: "/assets", label: "자료 목록", icon: FolderIcon, description: "에셋 및 문서 아카이브" },
    ],
  },
  {
    label: "도구",
    items: [
      { href: "/assistant", label: "AI 어시스턴트", icon: SparklesIcon, description: "정산·딜·파이프라인 등 대화형 조회" },
      { href: "/claim-check", label: "표현 검사", icon: ShieldCheckIcon, description: "브리프·셀러 콘텐츠의 광고 표현 법령 점검" },
    ],
  },
];

function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 사이드바 행(내비 14개 + 하단 설정·숨김모드·로그아웃)의 형태 정본.
 *
 * ⛔ 행마다 클래스 문자열을 복사해 두지 말 것. 손으로 복제된 4벌이 실제로 갈라졌다 —
 * `asChild` 행(내비·설정·로그아웃)은 안쪽 Link/button 이 `gap-3` 을 들고 있는데
 * `asChild` 가 아닌 숨김모드 행만 프리미티브 기본값 `gap-2` 로 떨어져, 라벨이 다른
 * 행보다 **4px 왼쪽**에서 시작했다(2026-08-25 오너 지적, 실측 x=41 vs 45).
 * 값이 한 곳에 있으면 그 드리프트가 성립하지 않는다.
 *
 * 아이콘↔라벨 간격이 ROW 와 INNER 양쪽에 있는 것은 중복이 아니라 **DOM 이 두 모양이기
 * 때문**이다: `asChild` 의 Slot 은 이 클래스를 안쪽 Link 와 **같은 노드**로 합치므로
 * ROW 가 곧 flex 컨테이너이고, 로그아웃 행만 form 을 한 겹 거쳐 안쪽 button 이
 * 아이콘·라벨을 품는다. 둘 다 상수라 갈라질 수 없다.
 */
const SIDEBAR_ROW_CLASS =
  "h-10 gap-3 rounded-lg pl-[15px] pr-3 text-[13px] text-sidebar-foreground/65 transition-[color,background-color,box-shadow,padding] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground " +
  "group-data-[collapsible=icon]:!w-full group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!px-0 group-data-[collapsible=icon]:!pl-[15px] group-data-[collapsible=icon]:gap-0";

/** active 오버라이드의 `!` 는 Tailwind v4 `:where()` 특이성 0 의 의도적 해법이다(P8 가드레일 5) — 지우지 말 것. */
const SIDEBAR_ROW_ACTIVE_CLASS =
  "!bg-sidebar-primary/[0.08] !text-sidebar-primary !font-semibold shadow-soft-sm hover:!bg-sidebar-primary/[0.12]";

/** `asChild` 안쪽에서 아이콘·라벨을 품는 flex 컨테이너. */
const SIDEBAR_ROW_INNER_CLASS =
  "flex w-full items-center justify-start gap-3 group-data-[collapsible=icon]:gap-0";

/** 접힘 모드에서 폭·높이·불투명도가 함께 죽는 라벨(그 상태의 단서는 툴팁이 맡는다). */
const SIDEBAR_LABEL_CLASS =
  "transition-[opacity,width,height] duration-200 ease-in-out whitespace-nowrap truncate inline-block " +
  "group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:h-0 group-data-[collapsible=icon]:overflow-hidden group-data-[collapsible=icon]:pointer-events-none";

/**
 * 승인대기 배지 (§6-2 v1.2 추가).
 * useApprovalInbox("PENDING_APPROVAL")와 동일 쿼리키를 공유해 추가 폴링 없이
 * 인박스 캐시를 재사용한다(§6-2 "사이드바가 추가 요청을 만들지 않고 캐시를 공유").
 * count===0이면 렌더하지 않는다. CrmSidebar가 이미 루트 layout의 Providers
 * (QueryClientProvider) 하위이므로 별도 클라이언트 컴포넌트 분리는 불필요하다
 * (레이아웃 구조 변경 없음 — src/app/layout.tsx 확인).
 */
export function ApprovalBadge() {
  const { count } = useApprovalInbox("PENDING_APPROVAL");
  if (count <= 0) return null;
  return (
    <Badge variant="status-pending" className="ml-auto">
      {count}
    </Badge>
  );
}

export function CrmSidebar() {
  const pathname = usePathname();
  // operator(카톡 업로드 전담 직원)는 내비게이션을 갖지 않는다 — 유일한 화면인
  // 업로드 페이지에 이미 와 있고, 나머지 경로는 미들웨어가 되돌린다. 남기는 것은
  // 브랜드 헤더와 로그아웃뿐이다(로그아웃까지 지우면 세션을 끝낼 방법이 없어진다).
  const isOperator = useUserRole() === "operator";
  // 상시 레일 + 호버·포커스로 임시 펼침. 핸들러는 `Sidebar` 의 패널 요소로 퍼진다.
  const peekHandlers = useSidebarPeek();
  const { isPrivacyMode, togglePrivacyMode } = usePrivacyMode();
  const PrivacyIcon = isPrivacyMode ? EyeIcon : EyeOffIcon;
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
  const [userName, setUserName] = React.useState<string | null>(null);

  React.useEffect(() => {
    // 데모 배포: Supabase env가 없어 createClient가 성립하지 않는다 — 표시용 프로필만 고정.
    if (isClientDemoMode()) {
      setUserName("데모 계정");
      return;
    }
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        const url = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
        setAvatarUrl(url);
        const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email || null;
        setUserName(name);
      } else {
        const isDevBypass =
          process.env.NODE_ENV === "development" &&
          (document.cookie.includes("wag_crm_dev_auth=1") ||
            document.cookie.includes("wag_crm_dev_auth%3D1") ||
            (typeof window !== "undefined" && window.localStorage.getItem("wag_crm_dev_auth") === "1"));
        if (isDevBypass) {
          setAvatarUrl("https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=256&auto=format&fit=crop");
          setUserName("Sunny");
        }
      }
    });
  }, []);

  return (
    <Sidebar
      collapsible="icon"
      peek
      {...peekHandlers}
      className="border-r border-sidebar-border bg-sidebar"
    >
      <SidebarHeader className="p-0 pt-4 pb-2 bg-transparent">
        {/* ⛔ 이 자리를 다시 버튼으로 만들지 말 것 — 접기/펼치기 토글이 사라졌고(호버로만
            열린다), 홈으로 가는 길은 바로 아래 「대시보드」 항목이 이미 소유한다.
            숨김모드에서는 이 자리가 프로필 표시로 바뀌므로 링크 의미가 더 어긋난다.
            설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md` §5-1 */}
        <div
          className={cn(
            "relative flex h-10 w-full items-center rounded-xl p-0 text-sidebar-foreground transition-colors duration-150 text-left",
            "group-data-[collapsible=icon]:!w-full group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!px-0",
          )}
        >
          {/* 36px 슬롯 — 마크가 타일 없는 선화라 이전 solid 칩(32px)보다 작아 보이는 것을
              보정한다(브랜드 마크 viewBox 는 아트가 폭 74.5%만 차지하는 세이프존을 포함).
              viewBox 를 조이지 않는 이유: 아이콘·파비콘과 같은 도형이어야 하므로 크롭은
              브랜드 번들 쪽 결정이다. 아바타도 같은 치수를 써야 프라이버시 토글 때 안 튄다. */}
          <div className="absolute left-[8px] top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center shrink-0">
            {isPrivacyMode ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={avatarUrl || "https://lh3.googleusercontent.com/a/default-user=s256-c"}
                alt="Profile"
                className="size-9 shrink-0 rounded-xl object-cover shadow-soft-sm"
                referrerPolicy="no-referrer"
              />
            ) : (
              <BrandMark
                title="WAG CRM"
                // 마크는 단색(currentColor)이라 text-* 가 곧 마크 색이다. 골드를 쓰는 건
                // 이 자리가 원래 골드 solid 칩이었기 때문이다 — 사이드바의 브랜드 앵커
                // 색을 유지한다. 사이드바 네이비 #08314E 위 골드 6.40:1(3:1 통과).
                className="size-9 text-sidebar-primary"
              />
            )}
          </div>
          <span className={cn(
            // 8(left) + 36(아이콘) + 8(간격). 아이콘 슬롯 폭과 함께 움직여야 한다.
            "pl-[52px] truncate transition-[opacity,width,height,color,font-size,font-weight,letter-spacing] duration-150 ease-in-out whitespace-nowrap inline-block",
            isPrivacyMode 
              ? "text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50"
              : "text-[15px] font-bold tracking-tight text-sidebar-foreground",
            "group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:h-0 group-data-[collapsible=icon]:overflow-hidden group-data-[collapsible=icon]:pointer-events-none"
          )}>
            {isPrivacyMode ? (userName || "User") : "WAG CRM"}
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="p-0 pt-2 bg-transparent">
        {(isOperator ? [] : navSections).map((section) => (
          <SidebarGroup
            key={section.label ?? "__unlabeled__"}
            className="relative flex w-full min-w-0 flex-col px-0 py-1"
          >
            {section.label ? (
            <SidebarGroupLabel
              className={cn(
                "pointer-events-none relative px-[15px] text-[10px] font-semibold tracking-normal text-sidebar-foreground/60",
                // 접힘 모드: 기본 -mt-8/opacity-0(투명 오버레이가 위 항목 클릭 차단)을
                // 해제하고 같은 h-8 슬롯에 가운데 구분선 렌더 — 아이콘 위치 불변.
                "group-data-[collapsible=icon]:mt-0 group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:px-0",
              )}
            >
              {/* 제목 텍스트는 내비 라벨과 동일한 opacity·width 전환으로 접히고 펼쳐진다.
                  (기존 display 토글은 폭 애니메이션 중 텍스트가 즉시 나타나 '튀어' 보였다 —
                  나머지 항목은 부드럽게 나타나는데 섹션 제목만 스냅됐던 비대칭이 원인.) */}
              <span
                className={cn(
                  "inline-block truncate whitespace-nowrap transition-[opacity,width] duration-200 ease-in-out",
                  "group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:overflow-hidden group-data-[collapsible=icon]:pointer-events-none",
                )}
              >
                {section.label}
              </span>
              {/* 구분선은 absolute(플로우 밖)라 텍스트 전환과 자리다툼 없이 opacity로
                  크로스페이드된다 — 펼침=텍스트 in·선 out, 접힘=텍스트 out·선 in. */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sidebar-border opacity-0 transition-opacity duration-200 group-data-[collapsible=icon]:opacity-100"
              />
            </SidebarGroupLabel>
            ) : null}
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActivePath(pathname, item.href);
                  return (
                    <SidebarMenuItem key={item.href} className="w-full flex justify-center">
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={`${item.label}: ${item.description}`}
                        className={cn(SIDEBAR_ROW_CLASS, active && SIDEBAR_ROW_ACTIVE_CLASS)}
                      >
                        <Link href={item.href} className={SIDEBAR_ROW_INNER_CLASS}>
                          <Icon />
                          <span className={SIDEBAR_LABEL_CLASS}>
                            {item.label}
                          </span>
                          {item.href === "/assistant" && <ApprovalBadge />}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-0 pb-4 bg-transparent">
        {/* 자식이 SidebarMenu 하나뿐이라 이 div 의 flex-col/gap 은 렌더에 닿지 않는다 —
            행 간격은 아래 SidebarMenu 가 소유한다(내비와 같은 gap-0.5). */}
        <div className="border-t border-sidebar-border pt-3">
          <SidebarMenu className="gap-0.5">
            {!isOperator && (
            <SidebarMenuItem className="w-full flex justify-center">
              <SidebarMenuButton
                asChild
                isActive={isActivePath(pathname, "/settings")}
                tooltip="설정"
                className={cn(
                  SIDEBAR_ROW_CLASS,
                  isActivePath(pathname, "/settings") && SIDEBAR_ROW_ACTIVE_CLASS,
                )}
              >
                <Link href="/settings/operations" className={SIDEBAR_ROW_INNER_CLASS}>
                  <Settings2Icon />
                  <span className={SIDEBAR_LABEL_CLASS}>
                    설정
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            )}
            <SidebarMenuItem className="w-full flex justify-center">
              <SidebarMenuButton
                type="button"
                onClick={togglePrivacyMode}
                tooltip={isPrivacyMode ? "숨김모드 끄기" : "숨김모드 켜기"}
                className={cn(SIDEBAR_ROW_CLASS, isPrivacyMode && SIDEBAR_ROW_ACTIVE_CLASS)}
              >
                <PrivacyIcon />
                <span className={SIDEBAR_LABEL_CLASS}>
                  {isPrivacyMode ? "숨김모드 해제" : "숨김모드"}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem className="w-full flex justify-center">
              <SidebarMenuButton
                asChild
                tooltip="로그아웃"
                className={SIDEBAR_ROW_CLASS}
              >
                <form action="/api/auth/signout" method="POST" className="w-full m-0 p-0">
                  <button
                    type="submit"
                    className={cn(SIDEBAR_ROW_INNER_CLASS, "h-full border-0 bg-transparent p-0 font-medium text-inherit")}
                  >
                    <LogOutIcon />
                    <span className={SIDEBAR_LABEL_CLASS}>
                      로그아웃
                    </span>
                    <span className="sr-only">로그아웃</span>
                  </button>
                </form>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
