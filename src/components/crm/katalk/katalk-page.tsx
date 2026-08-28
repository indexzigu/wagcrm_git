"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KatalkUploadTab } from "./upload-tab";
import { KatalkManageTab } from "./manage-tab";
import { useUserRole } from "@/hooks/use-user-role";

export function KatalkPage() {
  // operator 에게 이 페이지는 앱의 전부다 — 「방 관리」탭과 「자료 목록」 링크는 둘 다
  // 미들웨어가 막는 곳으로 나가므로(방 관리는 /api/chat-room-mappings/manage 를 부른다)
  // 눌러도 실패하는 UI 를 남기지 않고 아예 뺀다. 탭이 하나뿐이면 탭 껍데기도 뺀다.
  const isOperator = useUserRole() === "operator";

  return (
    <CrmShell
      title={
        <div className="flex flex-col gap-1">
          {!isOperator && (
            <Link
              href="/assets"
              className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5" />
              자료 목록
            </Link>
          )}
          <span>카톡 기록</span>
        </div>
      }
      description={isOperator ? "카톡 대화 txt 업로드" : "직원 카톡 txt 업로드 · 방 매핑 관리"}
    >
      <div className="flex flex-col gap-6 p-6 md:p-8">
        {isOperator ? (
          <KatalkUploadTab />
        ) : (
          <Tabs defaultValue="upload">
            <TabsList>
              <TabsTrigger value="upload">업로드</TabsTrigger>
              <TabsTrigger value="manage">방 관리</TabsTrigger>
            </TabsList>
            <TabsContent value="upload">
              <KatalkUploadTab />
            </TabsContent>
            <TabsContent value="manage">
              <KatalkManageTab />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </CrmShell>
  );
}
