"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { LinkSearchDialog } from "@/components/crm/link-search-dialog";
import { EntityLinkSelectField } from "@/components/crm/entity-link-select-field";
import {
  EntityIdentity,
  type EntityIdentityPart,
} from "@/components/crm/entity-identity";
import { SellerIdentityInfo } from "@/components/crm/seller-identity-info";
import { getDealContextParts } from "@/lib/deal-display";
import { OutreachMessageGenerator } from "@/components/crm/outreach-message-generator";

type OutreachCreateFormProps = {
  dealId?: string;
  preSelectedSellerId?: string;
  onSuccess: () => void;
};

export function OutreachCreateForm({
  dealId,
  preSelectedSellerId,
  onSuccess,
}: OutreachCreateFormProps) {
  const [selectedDealId, setSelectedDealId] = useState(dealId ?? "");
  const [selectedDealName, setSelectedDealName] = useState("");
  const [selectedDealContext, setSelectedDealContext] = useState<EntityIdentityPart[]>([]);

  const [sellerId, setSellerId] = useState(preSelectedSellerId ?? "");
  const [sellerName, setSellerName] = useState("");
  const [sellerSnsHandle, setSellerSnsHandle] = useState("");
  const [sellerSnsType, setSellerSnsType] = useState<string | null>(null);

  const [isDealSearchOpen, setIsDealSearchOpen] = useState(false);
  const [isSellerSearchOpen, setIsSellerSearchOpen] = useState(false);

  const [contactChannel, setContactChannel] = useState("DM");
  const [proposalMessage, setProposalMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchInitialNames() {
      try {
        if (dealId) {
          const res = await fetch(`/api/deals/${dealId}`);
          if (res.ok) {
            const data = await res.json();
            setSelectedDealName(data.deal?.dealName ?? data.dealName ?? "");
            setSelectedDealContext(
              getDealContextParts({
                brandName: data.deal?.brandName ?? data.brandName ?? null,
                partnerName: data.deal?.partner?.name ?? data.partnerName ?? null,
              }),
            );
          }
        }
        if (preSelectedSellerId) {
          const res = await fetch(`/api/sellers/${preSelectedSellerId}`);
          if (res.ok) {
            const data = await res.json();
            setSellerName(data.seller?.name ?? data.name ?? "");
            setSellerSnsHandle(data.seller?.snsHandle ?? data.snsHandle ?? "");
            setSellerSnsType(data.seller?.snsType ?? data.snsType ?? null);
          }
        }
      } catch {
        // silently fail
      }
    }
    void fetchInitialNames();
  }, [dealId, preSelectedSellerId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sellerId || !selectedDealId) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId: selectedDealId,
          sellerId,
          contactChannel,
          proposalMessage: proposalMessage.trim() || null,
        }),
      });

      if (response.ok) {
        toast.success("영업 테스크가 생성되었습니다");
        onSuccess();
        return;
      }

      const payload = await response.json();

      if (response.status === 409) {
        const message = payload.error ?? "이미 같은 딜과 셀러 조합의 영업 테스크가 있습니다";
        setError(message);
        toast.error(message);
      } else {
        const message = payload.error ?? "영업 테스크 생성에 실패했습니다";
        setError(message);
        toast.error(message);
      }
    } catch {
      setError("네트워크 오류가 발생했습니다");
      toast.error("네트워크 오류가 발생했습니다");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <FieldGroup>
          <EntityLinkSelectField
            label="딜"
            required
            selected={!!selectedDealId}
            emptyText="선택된 딜이 없습니다."
            actionLabel="딜 선택"
            changeLabel="딜 변경"
            disabled={!!dealId}
            onOpen={() => setIsDealSearchOpen(true)}
            selectedContent={
              <EntityIdentity
                variant="heading"
                parts={[
                  { label: "딜", value: selectedDealName || "로딩 중..." },
                  ...selectedDealContext,
                ]}
              />
            }
          />

          <EntityLinkSelectField
            label="셀러"
            required
            selected={!!sellerId}
            emptyText="선택된 셀러가 없습니다."
            actionLabel="셀러 검색 선택"
            changeLabel="셀러 변경"
            disabled={!!preSelectedSellerId}
            onOpen={() => setIsSellerSearchOpen(true)}
            selectedContent={
              <SellerIdentityInfo
                sellerName={sellerName || "로딩 중..."}
                snsHandle={sellerSnsHandle}
                snsType={sellerSnsType}
                variant="heading"
              />
            }
          />

          <Field>
            <FieldLabel htmlFor="channel-select">연락 수단</FieldLabel>
            <Select value={contactChannel} onValueChange={setContactChannel}>
              <SelectTrigger id="channel-select" className="w-full">
                <SelectValue placeholder="연락 수단을 선택하세요" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="DM">DM</SelectItem>
                  <SelectItem value="EMAIL">이메일</SelectItem>
                  <SelectItem value="KAKAO">카카오톡</SelectItem>
                  <SelectItem value="PHONE">전화</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription className="text-xs">최초 제안 채널을 남겨 후속 리마인드 기준으로 사용합니다.</FieldDescription>
          </Field>

          <Field>
            <div className="flex items-center justify-between mb-2">
              <FieldLabel htmlFor="proposal-message" className="mb-0">제안 메모</FieldLabel>
              <OutreachMessageGenerator 
                dealId={selectedDealId}
                sellerId={sellerId}
                onGenerated={(msg) => setProposalMessage(msg)}
              />
            </div>
            <Textarea
              id="proposal-message"
              value={proposalMessage}
              onChange={(event) => setProposalMessage(event.target.value)}
              placeholder="전달한 메시지나 조건 메모를 남깁니다."
              className="min-h-24"
            />
          </Field>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FieldError className="sr-only">
            {!sellerId || !selectedDealId ? "딜과 셀러를 선택해야 영업 테스크를 생성할 수 있습니다." : undefined}
          </FieldError>
        </FieldGroup>

        <Button
          type="submit"
          disabled={loading || !sellerId || !selectedDealId}
          className="w-full"
        >
          {loading ? "생성 중..." : "영업 테스크 생성"}
        </Button>
      </form>

      <LinkSearchDialog
        open={isDealSearchOpen}
        onOpenChange={setIsDealSearchOpen}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        simpleDealDisplay
        onSelect={(deal) => {
          setSelectedDealId(deal.id);
          setSelectedDealName(deal.label);
          setSelectedDealContext(
            deal.identityParts?.filter((part) => part.label !== "딜") ?? [],
          );
        }}
        title="딜 선택"
        placeholder="검색할 딜 또는 거래처 이름을 입력하세요"
      />

      <LinkSearchDialog
        open={isSellerSearchOpen}
        onOpenChange={setIsSellerSearchOpen}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={(item) => {
          setSellerId(item.id);
          setSellerName(item.label);
          setSellerSnsHandle(item.metadata?.snsHandle || item.sublabel?.split(" · ")[1] || "");
          setSellerSnsType(item.metadata?.snsType || item.sublabel?.split(" · ")[0] || null);
          setIsSellerSearchOpen(false);
        }}
        title="셀러 검색 선택"
        placeholder="검색할 셀러 이름을 입력하세요"
      />
    </>
  );
}
