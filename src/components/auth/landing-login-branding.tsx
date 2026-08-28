"use client";

import * as React from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { usePrivacyMode } from "@/components/crm/privacy-mode-provider";

const PRIVACY_MODE_STORAGE_KEY = "wag-crm:privacy-mode";

/**
 * 중립(privacy-safe) 문구를 보여줄지 결정하는 공용 훅.
 *
 * - 하이드레이션 이전(SSR 포함)에는 항상 중립이 기본값이다 — 저장된 설정을
 *   확인하기 전까지 회사 식별 정보를 절대 노출하지 않는다(fail-closed).
 * - 마운트 후에는 전역 PrivacyModeProvider 컨텍스트와 localStorage 직접 읽기를
 *   OR로 결합한다. 프로바이더는 마운트 직후 저장값을 잠시 "false"로 덮어쓰는
 *   초기화 레이스가 있어, 둘 중 하나라도 프라이버시를 요구하면 중립을 유지한다.
 * - 탭 제목(document.title) 중립화는 PrivacyModeProvider가 전역에서 담당한다.
 */
function useNeutralIdentity() {
  const { isPrivacyMode } = usePrivacyMode();
  // 하이드레이션 전 기본값 = 중립
  const [storedPrivacy, setStoredPrivacy] = React.useState(true);

  React.useEffect(() => {
    const privacyEnabled =
      window.localStorage.getItem(PRIVACY_MODE_STORAGE_KEY) === "true";

    setStoredPrivacy(privacyEnabled);
  }, []);

  return storedPrivacy || isPrivacyMode;
}

/** 좌측 상단 브랜드 마크 — 네이비 심볼 + 워드마크 */
export function LandingBrandMark() {
  const neutral = useNeutralIdentity();

  return (
    <div className="flex items-center gap-3">
      {/* 브랜드 마크는 그 자체가 회사 식별 정보다 — 중립 모드에서는 쓰지 않는다.
          여기서 마크를 노출하면 문구를 아무리 중립화해도 정체가 그림으로 샌다.
          중립 상태는 기존 무채색 글자 칩을 그대로 유지한다(fail-closed). */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary shadow-soft-sm shadow-primary/20">
        {neutral ? (
          <span className="text-[10px] font-extrabold tracking-[0.08em] text-white">W</span>
        ) : (
          // 마크를 네이비 칩 **안에** 넣는다 — 골드는 흰 배경 위 2.11:1 로 미달이라
          // 타일 없이 밝은 화면에 얹을 수 없다(P8 §5 표면 종속). 칩 안에서는 5.37:1.
          // 부수 효과로 이 배지가 실제 파비콘·홈화면 아이콘과 같은 모습이 된다.
          <BrandMark title="WAG CRM" className="size-7 text-accent-gold" />
        )}
      </div>
      <div className="leading-tight">
        <p className="text-sm font-bold tracking-tight text-slate-900">
          {neutral ? "Au79 CRM" : "WAG CRM"}
        </p>
        <p className="text-[11px] font-medium text-slate-500">
          {neutral ? "Private workspace" : "Yground Sales OS"}
        </p>
      </div>
    </div>
  );
}

/** 로그인 컬럼 헤드라인 — 페이지의 h1 */
export function LandingHeadline() {
  const neutral = useNeutralIdentity();

  if (neutral) {
    return (
      <div className="space-y-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Sign in
        </p>
        <h1
          id="landing-login-heading"
          className="text-3xl font-bold leading-[1.25] tracking-tight break-keep text-slate-900"
        >
          워크스페이스에
          <br />
          로그인하세요
        </h1>
        <p className="text-sm leading-relaxed break-keep text-slate-500">
          허가된 구성원만 접근할 수 있는 비공개 업무 공간입니다.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">
        Welcome back
      </p>
      <h1
        id="landing-login-heading"
        className="text-3xl font-bold leading-[1.25] tracking-tight break-keep text-slate-900"
      >
        오늘의 딜,
        <br />
        이어서 진행하세요
      </h1>
      <p className="text-sm leading-relaxed break-keep text-slate-500">
        와이그라운드 셀러 네트워크의 딜 운영과 정산을 한 화면에서 관리하는
        내부 워크스페이스입니다.
      </p>
    </div>
  );
}

/** 우측 에디토리얼 패널에 노출할 기능 요약 — 브랜드 노출 버전 */
const BRAND_FEATURES = [
  {
    no: "01",
    title: "파이프라인",
    desc: "제안부터 확정, 진행까지, 모든 딜의 단계를 실시간으로 추적합니다.",
  },
  {
    no: "02",
    title: "셀러 네트워크",
    desc: "인플루언서 파트너의 히스토리와 관계 데이터를 한곳에 모읍니다.",
  },
  {
    no: "03",
    title: "정산 자동화",
    desc: "매출 확정에서 정산 완료까지, 반복 작업 없이 흘러갑니다.",
  },
] as const;

/** 프라이버시 모드용 중립 기능 요약 — 회사·업무 식별 정보를 담지 않는다 */
const NEUTRAL_FEATURES = [
  {
    no: "01",
    title: "Overview",
    desc: "진행 중인 업무 현황을 한눈에 확인합니다.",
  },
  {
    no: "02",
    title: "Follow-up",
    desc: "이어서 처리할 항목을 놓치지 않고 챙깁니다.",
  },
  {
    no: "03",
    title: "Records",
    desc: "지난 작업 기록을 안전하게 보관합니다.",
  },
] as const;

/** 우측(데스크톱 전용) 에디토리얼 패널 — 얇은 괘선 리스트 중심의 잡지식 구성 */
export function LandingEditorialPanel() {
  const neutral = useNeutralIdentity();
  const features = neutral ? NEUTRAL_FEATURES : BRAND_FEATURES;

  return (
    <div className="relative z-10 max-w-xl border-l border-primary/15 pl-10 xl:pl-14">
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-primary/80">
        {neutral ? "Private Workspace" : "Yground · Media Commerce"}
      </p>

      <h2 className="mt-6 text-4xl font-semibold leading-[1.2] tracking-tight break-keep text-slate-900 xl:text-[2.75rem]">
        {neutral ? (
          <>
            진행 중인 모든 업무를
            <br />
            <span className="text-primary">하나의 화면</span>에서.
          </>
        ) : (
          <>
            흩어진 딜과 정산을
            <br />
            <span className="text-primary">하나의 흐름</span>으로.
          </>
        )}
      </h2>

      <p className="mt-5 max-w-md text-[15px] leading-relaxed break-keep text-slate-500">
        {neutral
          ? "허가된 구성원과 초대된 파트너를 위한 비공개 워크스페이스입니다."
          : "셀러 네트워크 공동구매 딜의 시작부터 정산까지, 운영의 모든 단계를 끊김 없이 잇습니다."}
      </p>

      {/* 얇은 괘선으로 구분한 넘버드 기능 리스트 */}
      <ul className="mt-14 border-t border-slate-200/80">
        {features.map((feature, index) => (
          <li
            key={feature.no}
            className="flex items-baseline gap-6 border-b border-slate-200/80 py-5 animate-fade-in-up"
            style={{
              animationDelay: `${120 + index * 90}ms`,
              animationFillMode: "backwards",
            }}
          >
            <span className="text-[11px] font-semibold tabular-nums text-slate-500">
              {feature.no}
            </span>
            <div>
              <h3 className="text-sm font-semibold tracking-tight text-slate-900">
                {feature.title}
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed break-keep text-slate-500">
                {feature.desc}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 좌측 하단 푸터 문구 */
export function LandingFooterNote() {
  const neutral = useNeutralIdentity();

  return (
    <p className="text-[11px] font-medium tracking-tight text-slate-500">
      {neutral
        ? "Private workspace"
        : "© 2026 Yground Co. 내부 구성원 및 초대된 파트너 전용"}
    </p>
  );
}
