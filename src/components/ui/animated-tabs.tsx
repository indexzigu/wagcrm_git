"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { motion, type Transition } from "motion/react";

import { cn } from "@/lib/utils";

// animate-ui의 TabsContent 크로스페이드는 별도 파일에서 재수출(호출부는 한 곳에서 import).
export { AnimatedTabsContent } from "./animated-tabs-content";

/**
 * animate-ui 슬라이딩 하이라이트 탭(경량 인라인 포크).
 *
 * 활성 트리거 뒤에 `layoutId` 공유 요소(흰 pill)를 렌더 → 탭 전환 시 motion이
 * 하이라이트를 이전 트리거에서 새 트리거로 스프링 슬라이드시킨다. animate-ui 원본의
 * Highlight/AutoHeight/strict-context/controlled-state 체인 대신, 활성값만 알면 되는
 * 최소 컨텍스트로 구현(추가 헬퍼 의존성 0). prefers-reduced-motion은 상위
 * <MotionConfig reducedMotion="user">가 자동 처리(layout 애니메이션 비활성).
 *
 * 우리 tabs.tsx(variant/orientation API·5화면 의존)는 그대로 두고, 슬라이딩 하이라이트가
 * 필요한 화면에서만 이 컴포넌트를 쓴다(additive). 사용 시 트리거의
 * `data-[state=active]:bg-*`(활성 배경)는 제거하고 하이라이트에 맡긴다.
 */

const ActiveTabContext = React.createContext<string | undefined>(undefined);
const HighlightIdContext = React.createContext<string>("animated-tab-highlight");

type AnimatedTabsProps = React.ComponentProps<typeof TabsPrimitive.Root>;

function AnimatedTabs({
  value,
  defaultValue,
  onValueChange,
  ...props
}: AnimatedTabsProps) {
  const [internal, setInternal] = React.useState<string | undefined>(
    defaultValue,
  );
  const active = value !== undefined ? value : internal;
  const reactId = React.useId();

  const handleChange = (v: string) => {
    if (value === undefined) setInternal(v);
    onValueChange?.(v);
  };

  return (
    <HighlightIdContext.Provider value={`animated-tab-hl-${reactId}`}>
      <ActiveTabContext.Provider value={active}>
        <TabsPrimitive.Root
          data-slot="animated-tabs"
          value={value}
          defaultValue={defaultValue}
          onValueChange={handleChange}
          {...props}
        />
      </ActiveTabContext.Provider>
    </HighlightIdContext.Provider>
  );
}

type AnimatedTabsListProps = React.ComponentProps<typeof TabsPrimitive.List>;

function AnimatedTabsList(props: AnimatedTabsListProps) {
  return <TabsPrimitive.List data-slot="animated-tabs-list" {...props} />;
}

type AnimatedTabsTriggerProps = React.ComponentProps<
  typeof TabsPrimitive.Trigger
> & {
  /** 슬라이딩 하이라이트 pill의 스타일(기본: 흰 배경 + 미세 그림자). */
  highlightClassName?: string;
  transition?: Transition;
};

function AnimatedTabsTrigger({
  value,
  className,
  children,
  highlightClassName,
  transition = { type: "spring", stiffness: 200, damping: 25 },
  ...props
}: AnimatedTabsTriggerProps) {
  const active = React.useContext(ActiveTabContext) === value;
  const highlightId = React.useContext(HighlightIdContext);

  return (
    <TabsPrimitive.Trigger
      value={value}
      data-slot="animated-tabs-trigger"
      className={cn("relative", className)}
      {...props}
    >
      {active && (
        <motion.div
          layoutId={highlightId}
          transition={transition}
          className={cn(
            "absolute inset-0 z-0 rounded-sm bg-white shadow-soft-sm",
            highlightClassName,
          )}
        />
      )}
      <span className="relative z-10">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

export {
  AnimatedTabs,
  AnimatedTabsList,
  AnimatedTabsTrigger,
  type AnimatedTabsProps,
  type AnimatedTabsListProps,
  type AnimatedTabsTriggerProps,
};
