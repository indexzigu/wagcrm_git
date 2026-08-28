"use client";

import * as React from "react";
import { MOBILE_USER_AGENT_REGEX } from "@/lib/mobile-user-agent";

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const userAgent = typeof window.navigator === "undefined" ? "" : navigator.userAgent;
    setIsMobile(MOBILE_USER_AGENT_REGEX.test(userAgent));
  }, []);

  return isMobile;
}
