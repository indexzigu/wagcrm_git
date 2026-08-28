"use client";

import { useEffect } from "react";
import { trackingParamKeys } from "@/lib/tracking";

export function TrackingParamCapture() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    for (const key of trackingParamKeys) {
      const value = params.get(key);
      if (value) localStorage.setItem(`wag:${key}`, value);
    }
    if (window.location.href) {
      localStorage.setItem("wag:landingUrl", window.location.href);
    }
  }, []);

  return null;
}
