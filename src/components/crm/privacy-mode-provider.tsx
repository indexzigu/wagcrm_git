"use client";

import * as React from "react";

const PRIVACY_MODE_STORAGE_KEY = "wag-crm:privacy-mode";
const DEFAULT_TITLE = "WAG CRM";
const PRIVACY_TITLE = "Au79 CRM";

type PrivacyModeContextValue = {
  isPrivacyMode: boolean;
  togglePrivacyMode: () => void;
};

const PrivacyModeContext = React.createContext<PrivacyModeContextValue | null>(null);

/**
 * Keeps the operator privacy display preference local to the current browser.
 */
export function PrivacyModeProvider({ children }: { children: React.ReactNode }) {
  const [isPrivacyMode, setIsPrivacyMode] = React.useState(false);

  // 저장된 설정 로드(마운트 1회). 여기서는 localStorage에 쓰지 않는다 —
  // 초기 렌더의 기본값(false)이 저장된 "true"를 잠시 덮어쓰던 레이스를 제거한다
  // (스트리밍으로 늦게 하이드레이션되는 컴포넌트가 그 창에서 오염된 값을 읽던 문제).
  React.useEffect(() => {
    setIsPrivacyMode(window.localStorage.getItem(PRIVACY_MODE_STORAGE_KEY) === "true");
  }, []);

  // 상태 → DOM 반영. 탭 제목은 Next 스트리밍 메타데이터 커밋이 <title>을 기본값("WAG CRM")으로
  // 되돌리므로, 단순 대입만으로는 프라이버시 ON에서도 회사명이 노출된다. 프라이버시 ON 동안에는
  // <head>를 MutationObserver로 감시해 제목이 바뀔 때마다 즉시 중립 제목으로 재적용한다.
  React.useEffect(() => {
    document.documentElement.dataset.privacyMode = isPrivacyMode ? "on" : "off";

    if (!isPrivacyMode) {
      document.title = DEFAULT_TITLE;
      return;
    }

    document.title = PRIVACY_TITLE;
    const observer = new MutationObserver(() => {
      if (document.title !== PRIVACY_TITLE) {
        document.title = PRIVACY_TITLE;
      }
    });
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [isPrivacyMode]);

  const togglePrivacyMode = React.useCallback(() => {
    setIsPrivacyMode((current) => {
      const next = !current;
      // 저장은 명시적 토글에서만 — 마운트 시 저장값을 덮어쓰지 않는다.
      window.localStorage.setItem(PRIVACY_MODE_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const value = React.useMemo<PrivacyModeContextValue>(
    () => ({ isPrivacyMode, togglePrivacyMode }),
    [isPrivacyMode, togglePrivacyMode],
  );

  return <PrivacyModeContext.Provider value={value}>{children}</PrivacyModeContext.Provider>;
}

export function usePrivacyMode() {
  const context = React.useContext(PrivacyModeContext);
  if (!context) {
    throw new Error("usePrivacyMode must be used within PrivacyModeProvider");
  }
  return context;
}
