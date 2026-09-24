"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 모바일 시트 스크롤 컨테이너용 당겨서 새로고침 훅.
 *
 * - 컨테이너 scrollTop 0에서 시작한 아래 방향 터치만 당김으로 인식한다.
 * - 당김 임계(~70px, 감쇠 적용 후) 도달 후 손을 떼면 onRefresh를 1회 실행.
 * - refreshing 중 재트리거 무시, 마지막 성공 후 20초 스로틀(네트워크 없이 무시).
 * - prefers-reduced-motion을 읽어 인디케이터 애니메이션 게이트로 노출한다.
 * - 컨테이너에는 overscroll-behavior-y: contain을 함께 적용할 것(iOS Safari
 *   네이티브 PTR·바운스 체이닝 충돌 방지) — 스타일은 호출부 책임.
 */

export const PULL_THRESHOLD_PX = 70;
export const PULL_MAX_PX = 110;
export const PULL_DAMPING = 0.5;
// 성공 후 스로틀 10s → 20s (2026-07-15 egress 절감): 서버 TTL 기본 90s·분당 한도
// 기본 3회 하향과 정합 — 연속 당김이 서버 왕복(레이트리밋 소진·스냅샷 재조회 egress)만
// 낭비하는 것을 클라이언트 단에서 먼저 줄인다. 실패 시에는 스로틀 없음(아래 catch 참조).
export const REFRESH_THROTTLE_MS = 20_000;

/** 손가락 이동량(px) → 감쇠·상한이 적용된 표시용 당김 거리. */
export function computePullOffset(
  deltaY: number,
  maxPx: number = PULL_MAX_PX,
  damping: number = PULL_DAMPING,
): number {
  if (deltaY <= 0) return 0;
  return Math.min(deltaY * damping, maxPx);
}

/** touchend 시점의 새로고침 실행 여부 판정(순수). */
export function shouldFireRefresh(params: {
  pullDistance: number;
  refreshing: boolean;
  lastSuccessAt: number | null;
  now: number;
  thresholdPx?: number;
  throttleMs?: number;
}): boolean {
  const {
    pullDistance,
    refreshing,
    lastSuccessAt,
    now,
    thresholdPx = PULL_THRESHOLD_PX,
    throttleMs = REFRESH_THROTTLE_MS,
  } = params;
  if (refreshing) return false;
  if (pullDistance < thresholdPx) return false;
  if (lastSuccessAt != null && now - lastSuccessAt < throttleMs) return false;
  return true;
}

export interface UsePullToRefreshOptions {
  /** 임계 통과 후 손을 뗐을 때 실행. resolve까지 refreshing=true. */
  onRefresh: () => Promise<void> | void;
  disabled?: boolean;
  thresholdPx?: number;
  throttleMs?: number;
}

export interface UsePullToRefreshResult {
  /** 스크롤 컨테이너에 붙이는 콜백 ref (포털·조건부 마운트 안전). */
  containerRef: (node: HTMLElement | null) => void;
  /** 현재 당김 거리(px, 감쇠 후). 인디케이터 높이로 사용. */
  pullDistance: number;
  refreshing: boolean;
  /** prefers-reduced-motion: reduce — 인디케이터 애니메이션 게이트. */
  reducedMotion: boolean;
  /**
   * 제스처 없이 같은 새로고침을 실행한다(버튼 경로 — 키보드·보조기술 사용자는 당길 수 없다).
   * 당김 임계만 건너뛰고 진행 중 무시·성공 후 스로틀은 제스처와 **같은 판정**을 쓴다 —
   * 두 경로가 따로 돌면 버튼으로 스로틀을 우회해 서버 왕복을 늘리게 된다.
   * @returns 실행했으면 true, 진행 중·스로틀·비활성으로 무시했으면 false.
   */
  triggerRefresh: () => boolean;
  /**
   * 진행 중인 새로고침이 **당김 제스처**로 시작됐는가. 상단 당김 인디케이터는 이것일 때만
   * 펼친다 — 버튼으로 시작한 새로고침까지 펼치면 버튼 아이콘과 스피너가 둘이 되고 본문이
   * 36px 밀린다(ss-ux 검토 P1). 버튼 경로는 버튼 자신이 진행을 보여 준다.
   */
  refreshingByGesture: boolean;
}

export function usePullToRefresh(
  options: UsePullToRefreshOptions,
): UsePullToRefreshResult {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingByGesture, setRefreshingByGesture] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  // 리스너 안에서 최신 값을 읽기 위한 ref 미러들.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const lastSuccessAtRef = useRef<number | null>(null);
  const gestureRef = useRef<{ active: boolean; startY: number }>({
    active: false,
    startY: 0,
  });
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // 언마운트 시 리스너 정리.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const setPull = useCallback((value: number) => {
    pullRef.current = value;
    setPullDistance(value);
  }, []);

  // 제스처·버튼 공용 실행부 — 판정(shouldFireRefresh)을 통과한 뒤에만 부른다.
  const startRefresh = useCallback((source: "gesture" | "button") => {
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshingByGesture(source === "gesture");
    Promise.resolve()
      .then(() => optionsRef.current.onRefresh())
      .then(() => {
        lastSuccessAtRef.current = Date.now();
      })
      .catch((error) => {
        // 실패 시 스로틀을 걸지 않아 즉시 재시도할 수 있다.
        console.error("pull-to-refresh onRefresh failed:", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
        setRefreshingByGesture(false);
      });
  }, []);

  const triggerRefresh = useCallback((): boolean => {
    if (optionsRef.current.disabled) return false;
    const thresholdPx = optionsRef.current.thresholdPx ?? PULL_THRESHOLD_PX;
    if (
      !shouldFireRefresh({
        // 버튼은 당김 거리가 없다 — 임계를 그대로 넘겨 거리 조건만 통과시킨다.
        pullDistance: thresholdPx,
        refreshing: refreshingRef.current,
        lastSuccessAt: lastSuccessAtRef.current,
        now: Date.now(),
        thresholdPx,
        throttleMs: optionsRef.current.throttleMs,
      })
    ) {
      return false;
    }
    startRefresh("button");
    return true;
  }, [startRefresh]);

  const containerRef = useCallback(
    (node: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!node) return;

      const onTouchStart = (event: TouchEvent) => {
        if (optionsRef.current.disabled || refreshingRef.current) return;
        if (node.scrollTop > 0) return;
        const touch = event.touches[0];
        if (!touch) return;
        gestureRef.current = { active: true, startY: touch.clientY };
      };

      const onTouchMove = (event: TouchEvent) => {
        if (!gestureRef.current.active) return;
        if (node.scrollTop > 0) {
          // 당김 도중 컨테이너가 스크롤되면 제스처를 포기한다.
          gestureRef.current.active = false;
          setPull(0);
          return;
        }
        const touch = event.touches[0];
        if (!touch) return;
        const deltaY = touch.clientY - gestureRef.current.startY;
        setPull(computePullOffset(deltaY));
      };

      const finishGesture = () => {
        if (!gestureRef.current.active) return;
        gestureRef.current.active = false;
        const distance = pullRef.current;
        setPull(0);

        if (
          !shouldFireRefresh({
            pullDistance: distance,
            refreshing: refreshingRef.current,
            lastSuccessAt: lastSuccessAtRef.current,
            now: Date.now(),
            thresholdPx: optionsRef.current.thresholdPx,
            throttleMs: optionsRef.current.throttleMs,
          })
        ) {
          return;
        }

        startRefresh("gesture");
      };

      const onTouchCancel = () => {
        gestureRef.current.active = false;
        setPull(0);
      };

      // passive: 스크롤을 막지 않는다 — 네이티브 PTR 충돌은 컨테이너의
      // overscroll-behavior-y: contain이 차단한다.
      node.addEventListener("touchstart", onTouchStart, { passive: true });
      node.addEventListener("touchmove", onTouchMove, { passive: true });
      node.addEventListener("touchend", finishGesture);
      node.addEventListener("touchcancel", onTouchCancel);

      cleanupRef.current = () => {
        node.removeEventListener("touchstart", onTouchStart);
        node.removeEventListener("touchmove", onTouchMove);
        node.removeEventListener("touchend", finishGesture);
        node.removeEventListener("touchcancel", onTouchCancel);
      };
    },
    [setPull, startRefresh],
  );

  return { containerRef, pullDistance, refreshing, reducedMotion, triggerRefresh, refreshingByGesture };
}
