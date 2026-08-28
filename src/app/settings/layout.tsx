"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CrmShell } from "@/components/crm/crm-shell";
import { cn } from "@/lib/utils";
import { Settings2Icon, BellRingIcon, HardDriveIcon, UsersIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const settingsNav = [
  {
    href: "/settings/operations",
    label: "운영 정책",
    icon: Settings2Icon,
    description: "매출 목표, 채널 수수료, 일정 기준일 관리",
  },
  {
    href: "/settings/reminders",
    label: "자동화 및 알림",
    icon: BellRingIcon,
    description: "무응답 및 정산 지연 리마인더 정책",
  },
  {
    href: "/settings/integrations",
    label: "외부 연동 진단",
    icon: HardDriveIcon,
    description: "구글 드라이브 및 캘린더 연동 상태 및 권한 검사",
  },
  {
    href: "/settings/accounts",
    label: "계정 관리",
    icon: UsersIcon,
    description: "로그인 승인과 역할(admin/operator) 부여",
  },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <CrmShell>
      <TooltipProvider delayDuration={150}>
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
            {/* Top Navigation Bar */}
            <section className="flex min-h-12 shrink-0 border-b border-border/70 bg-white/40 px-5 py-2 overflow-x-auto">
              <nav className="flex items-center gap-1.5 min-w-max">
                {settingsNav.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);

                  return (
                    <Tooltip key={item.href}>
                      <TooltipTrigger asChild>
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors duration-200",
                            isActive
                              ? "bg-primary/[0.08] text-primary font-semibold"
                              : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
                          )}
                        >
                          <Icon className={cn("size-3.5 shrink-0", isActive ? "text-primary" : "text-muted-foreground/70")} />
                          <span>{item.label}</span>
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" align="center" className="text-[10px] py-1 px-2.5">
                        {item.description}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </nav>
            </section>

            {/* Main Content Area */}
            <main className="flex-1 overflow-auto bg-transparent min-h-0 p-5 md:p-8">
              {children}
            </main>
          </div>
        </section>
      </TooltipProvider>
    </CrmShell>
  );
}

