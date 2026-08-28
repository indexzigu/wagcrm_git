"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SellerSummary } from "@/lib/crm-types";
import { SellerCreationForm } from "./seller-creation-form";
import { SellerDetailContent } from "./seller-detail-content";

export type SellerPanelData = SellerSummary;

export type SellersPanelProps = {
  seller: SellerPanelData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated?: (seller: SellerPanelData) => void;
  onCreated?: (seller: SellerPanelData) => void;
  onDeleted?: (sellerId: string) => void;
  mode?: "view" | "create";
};

function useDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}

export function SellersPanel({
  seller,
  open,
  onOpenChange,
  onUpdated,
  onCreated,
  onDeleted,
  mode = "view",
}: SellersPanelProps) {
  const isDesktop = useDesktop();

  // ESC key handler
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  if (mode === "create") {
    const createBody = (
      <SellerCreationForm
        onCreated={onCreated}
        onSuccess={() => onOpenChange(false)}
        onCancel={() => onOpenChange(false)}
      />
    );

    return isDesktop ? (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0 overflow-hidden flex flex-col max-h-[85vh]">
          <DialogHeader className="shrink-0 border-b border-border/70 px-6 py-5">
            <DialogTitle>신규 셀러 등록</DialogTitle>
            <DialogDescription>
              캠페인명과 영업 큐에서 사용할 셀러 식별 정보를 등록합니다.
            </DialogDescription>
          </DialogHeader>
          {/* scrollbar-gutter: 내용이 85vh를 넘겨 스크롤바가 등장할 때 폭 흔들림 방지(PR #57 관례). */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-7 [scrollbar-gutter:stable]">{createBody}</div>
        </DialogContent>
      </Dialog>
    ) : (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[88vh] px-5 pb-5 duration-300 ease-in-out">
          <DrawerHeader className="flex-row items-center justify-between px-0">
            <div>
              <DrawerTitle>신규 셀러 등록</DrawerTitle>
              <DrawerDescription>
                캠페인명과 영업 큐에서 사용할 셀러 식별 정보를 등록합니다.
              </DrawerDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
            >
              <X />
            </Button>
          </DrawerHeader>
          <div className="overflow-y-auto">{createBody}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  if (!seller) return null;

  return isDesktop ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        style={{ width: "min(640px, 96vw)", maxWidth: "min(640px, 96vw)" }}
        className="flex flex-col overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0"
      >
        <SheetHeader className="shrink-0 border-b border-border/70 px-6 py-5">
          <SheetTitle>셀러 상세</SheetTitle>
          <SheetDescription>
            셀러 정보, 성과 요약, 캠페인 이력을 확인합니다.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
          <SellerDetailContent
            seller={seller}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  ) : (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[88vh] px-5 pb-5 duration-300 ease-in-out">
        <DrawerHeader className="flex-row items-center justify-between px-0">
          <div>
            <DrawerTitle>셀러 상세</DrawerTitle>
            <DrawerDescription>
              셀러 정보, 성과 요약, 캠페인 이력을 확인합니다.
            </DrawerDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
            <X />
          </Button>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SellerDetailContent
            seller={seller}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
            onClose={() => onOpenChange(false)}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
