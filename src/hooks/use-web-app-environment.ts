"use client";

import { useState, useEffect } from "react";

type WebAppEnvironment = {
  isReady: boolean;
  isMobile: boolean;
  isStandalone: boolean;
  isIos: boolean;
};

function detectEnvironment(): Omit<WebAppEnvironment, "isReady"> {
  const userAgent = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(userAgent);
  const isMobile =
    /Android|iPhone|iPad|iPod|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  const standaloneMedia = window.matchMedia("(display-mode: standalone)").matches;
  const navigatorStandalone =
    "standalone" in window.navigator &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

  return {
    isMobile,
    isStandalone: standaloneMedia || navigatorStandalone,
    isIos,
  };
}

export function useWebAppEnvironment(): WebAppEnvironment {
  const [env, setEnv] = useState<WebAppEnvironment>({
    isReady: false,
    isMobile: false,
    isStandalone: false,
    isIos: false,
  });

  useEffect(() => {
    setEnv({
      ...detectEnvironment(),
      isReady: true,
    });
  }, []);

  return env;
}
