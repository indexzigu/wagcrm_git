"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { motion, type HTMLMotionProps, type Transition } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * animate-ui의 TabsContent 모션 패턴(선별 포크).
 *
 * 활성 탭 패널이 마운트될 때 opacity + blur + 미세 y 이동이 풀리며 부드럽게
 * 등장한다. 우리 `tabs.tsx`의 Tabs/TabsList/TabsTrigger와 그대로 함께 쓰는
 * 드롭인 대체물이다 — 기존 <TabsContent> 자리에 넣기만 하면 된다.
 *
 * radix Content는 기본적으로 활성 탭만 마운트하므로 탭 전환마다 enter
 * 트랜지션이 재생된다. animate-ui 원본의 exit / forceMount / auto-height 체인은
 * 운영 화면 리스크를 줄이기 위해 의도적으로 제외했다(추가 헬퍼 의존성 0).
 * prefers-reduced-motion은 상위 <MotionConfig reducedMotion="user">가 자동 처리한다.
 */
type AnimatedTabsContentProps = {
  value: string;
  className?: string;
  children?: React.ReactNode;
  transition?: Transition;
} & Omit<HTMLMotionProps<"div">, "children">;

function AnimatedTabsContent({
  value,
  className,
  children,
  transition = { duration: 0.35, ease: "easeOut" },
  ...motionProps
}: AnimatedTabsContentProps) {
  return (
    <TabsPrimitive.Content value={value} asChild>
      <motion.div
        data-slot="animated-tabs-content"
        initial={{ opacity: 0, filter: "blur(4px)", y: 4 }}
        animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
        transition={transition}
        className={cn("flex-1 outline-none", className)}
        {...motionProps}
      >
        {children}
      </motion.div>
    </TabsPrimitive.Content>
  );
}

export { AnimatedTabsContent, type AnimatedTabsContentProps };
