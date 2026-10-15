"use client";

/**
 * 「거래처 등록」 기안 카드의 **계산서에서 채우기** 칸(오너 지시 2026-10-15).
 *
 * 승인자가 하는 판단: 「봇이 상호만 들고 온 거래처를, 대표자·주소·업태·종목·이메일까지 갖춘 채로
 * 등록해도 되는가」. 그래서 이 칸은 ①저장하면 안 될 수 있는 신호(같은 사업자번호의 거래처가 이미
 * 있다 · 상호로만 맞췄다) ②찾은 값이 기안의 어느 칸을 채우는지 ③승인할 때 같이 저장할지를 이 순서로
 * 보여 준다. 찾기는 버튼을 눌렀을 때만 한다 — 메일함을 반년 치 읽는 일이라 카드가 그려질 때마다
 * 돌리면 결재함이 느려진다.
 *
 * 「함께 저장」의 기본값은 **사업자번호로 맞췄고 같은 번호의 거래처가 없을 때만** 켠다. 상호로만
 * 맞췄거나 중복 의심이면 꺼 둔다 — 다른 업체의 대표자·주소가 승인 한 번에 저장되는 것이 이 칸에서
 * 가장 나쁜 결과라서다(화면·코드 교차 검토 2026-10-15).
 *
 * 규칙(빈 칸만 채운다)은 `lib/agent/partner-enrichment.ts` 가 소유한다. 여기서 다시 판정하지
 * 않고 API 가 준 `plan` 을 그대로 그린다. 저장은 승인 요청에 실린 값으로 서버가 다시 「빈 칸만」을 지킨다.
 *
 * ⚠️ react-query 를 쓰지 않는다 — 이 칸은 결재함 목록 카드(`PendingCard`)에도 얹히는데, 그 카드는
 * 쿼리 공급자 없이도 그려지는 표면이다(일괄 승인 목록 테스트가 그렇게 렌더한다).
 */

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PARTNER_ENRICHMENT_LABELS,
  type PartnerEnrichment,
  type PartnerEnrichmentPlan,
  type PartnerEnrichmentRow,
} from "@/lib/agent/partner-enrichment";
import type { PartnerInvoiceLookup } from "@/lib/tax-invoice-mail/partner-invoice-lookup";

/** `GET /api/action-proposals/[id]/partner-invoice-lookup` 응답 모양(라우트와 맞춘다). */
export type PartnerInvoiceLookupResponse = {
  lookup: PartnerInvoiceLookup;
  plan: PartnerEnrichmentPlan | null;
  existingPartner: { id: string; name: string } | null;
  scan: { sinceDays: number; mailsRead: number; truncated: number };
};

type FoundLookup = Extract<PartnerInvoiceLookup, { status: "FOUND" }>;

async function fetchLookup(proposalId: string): Promise<PartnerInvoiceLookupResponse> {
  const res = await fetch(`/api/action-proposals/${proposalId}/partner-invoice-lookup`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `계산서를 찾지 못했습니다 (status=${res.status})`);
  }
  return body as PartnerInvoiceLookupResponse;
}

function fillCountOf(plan: PartnerEnrichmentPlan | null): number {
  return plan ? Object.keys(plan.fills).length : 0;
}

/** 「함께 저장」 기본값 — 머리 주석의 규칙. 결과가 새로 올 때마다 다시 정한다. */
function defaultInclude(data: PartnerInvoiceLookupResponse): boolean {
  return (
    data.lookup.status === "FOUND" &&
    data.lookup.matchedBy === "BUSINESS_NUMBER" &&
    data.existingPartner === null
  );
}

const OUTCOME_TEXT: Record<PartnerEnrichmentRow["outcome"], string> = {
  FILL: "채움",
  SAME: "같음",
  KEEP: "기안 값 유지",
  INVALID: "저장 불가",
};

function OutcomeTag({ row }: { row: PartnerEnrichmentRow }) {
  if (row.outcome === "FILL") {
    // 브랜드 네이비 틴트 = 중립 태그 캐리어(P8 §4). 「이 칸이 새로 들어간다」만 말한다.
    return <span className="rounded-sm bg-primary/10 px-1 text-primary">{OUTCOME_TEXT.FILL}</span>;
  }
  if (row.outcome === "SAME") {
    return <span className="text-muted-foreground">{OUTCOME_TEXT.SAME}</span>;
  }
  return <span className="text-status-caution-text">{OUTCOME_TEXT[row.outcome]}</span>;
}

/**
 * 칸 하나. **저장될 값이 본문**이다 — 기안 값을 유지하는 칸은 기안 값을 크게, 계산서 값을 보조로
 * 둔다(반대로 두면 저장되지 않을 값이 가장 눈에 띈다). 같은 칸은 확인할 것이 없어 흐리게 둔다.
 */
function PlanRow({ row }: { row: PartnerEnrichmentRow }) {
  const isKeep = row.outcome === "KEEP" && row.proposedValue !== null;
  const main = isKeep ? row.proposedValue : row.invoiceValue;
  return (
    <div className="contents">
      <dt className="min-w-[4.5rem] text-muted-foreground">{PARTNER_ENRICHMENT_LABELS[row.field]}</dt>
      <dd
        className={cn(
          "min-w-0 break-words tabular-nums",
          row.outcome === "SAME" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {main}
        {isKeep ? <span className="block text-muted-foreground">계산서: {row.invoiceValue}</span> : null}
        {row.outcome === "INVALID" ? (
          <span className="block text-muted-foreground">거래처 칸에 들어가지 않는 길이입니다.</span>
        ) : null}
      </dd>
      <dd className="text-right">
        <OutcomeTag row={row} />
      </dd>
    </div>
  );
}

function PlanRows({ rows }: { rows: readonly PartnerEnrichmentRow[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 gap-y-1">
      {rows.map((row) => (
        <PlanRow key={row.field} row={row} />
      ))}
    </dl>
  );
}

/** 저장하면 안 될 수 있는 신호 — 결과의 맨 위에 둔다. */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="border-l-2 border-status-caution-text pl-2 font-medium text-status-caution-text">
      {children}
    </p>
  );
}

function MatchLine({ lookup }: { lookup: FoundLookup }) {
  const date = lookup.latestWrittenDate ? ` · 최근 작성일 ${lookup.latestWrittenDate}` : "";
  if (lookup.matchedBy === "BUSINESS_NUMBER") {
    return (
      <p className="text-muted-foreground">
        사업자번호가 같은 계산서 {lookup.invoiceCount}장{date}
      </p>
    );
  }
  return (
    <Warning>
      상호만 같은 계산서 {lookup.invoiceCount}장입니다{date}. 계산서 상호 「
      {lookup.counterpart.name ?? "상호 없음"}」가 이 거래처가 맞으면 저장하세요.
    </Warning>
  );
}

function ScanNote({ scan }: { scan: PartnerInvoiceLookupResponse["scan"] }) {
  if (scan.truncated === 0) return null;
  return (
    <p className="text-muted-foreground">
      메일이 많아 {scan.truncated.toLocaleString("ko-KR")}통은 읽지 못했습니다.
    </p>
  );
}

function SaveToggle({
  fillCount,
  include,
  onIncludeChange,
  bulkSelectable,
}: {
  fillCount: number;
  include: boolean;
  onIncludeChange: (next: boolean) => void;
  bulkSelectable: boolean;
}) {
  if (fillCount === 0) {
    return <p className="text-muted-foreground">채울 빈 칸이 없습니다. 기안에 이미 값이 있습니다.</p>;
  }
  return (
    <>
      <label className="flex min-h-8 cursor-pointer items-center gap-2 py-1.5 text-foreground">
        <input
          type="checkbox"
          checked={include}
          onChange={(event) => onIncludeChange(event.target.checked)}
          className="size-4 cursor-pointer accent-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        승인할 때 「채움」 {fillCount}칸도 함께 저장
      </label>
      {bulkSelectable && include ? (
        <p className="text-muted-foreground">
          일괄 승인에는 실리지 않습니다. 이 카드의 승인 버튼으로 승인하세요.
        </p>
      ) : null}
    </>
  );
}

function Result({
  data,
  include,
  onIncludeChange,
  bulkSelectable,
}: {
  data: PartnerInvoiceLookupResponse;
  include: boolean;
  onIncludeChange: (next: boolean) => void;
  bulkSelectable: boolean;
}) {
  const { lookup, plan, existingPartner, scan } = data;
  const duplicate = existingPartner ? (
    <Warning>
      같은 사업자번호의 거래처가 이미 있습니다: {existingPartner.name}. 새로 등록하면 중복입니다.
    </Warning>
  ) : null;

  if (lookup.status === "NOT_FOUND") {
    return (
      <>
        {duplicate}
        <p className="text-muted-foreground">
          최근 {scan.sinceDays}일 메일함에 이 거래처와 주고받은 계산서가 없습니다. 그대로 승인하면 기안에
          있는 값만 저장됩니다.
        </p>
        <ScanNote scan={scan} />
      </>
    );
  }
  if (lookup.status === "AMBIGUOUS") {
    return (
      <>
        {duplicate}
        <Warning>상호가 같은 사업자가 여러 곳이라 채우지 않았습니다.</Warning>
        <ul className="space-y-0.5 text-foreground">
          {lookup.candidates.map((candidate) => (
            <li key={candidate.businessNumber}>
              {candidate.name ?? "상호 없음"} <span className="tabular-nums">{candidate.businessNumber}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">봇에게 사업자번호를 알려 주고 다시 기안하세요.</p>
      </>
    );
  }

  return (
    <>
      {duplicate}
      <MatchLine lookup={lookup} />
      {plan && plan.rows.length > 0 ? <PlanRows rows={plan.rows} /> : null}
      <SaveToggle
        fillCount={fillCountOf(plan)}
        include={include}
        onIncludeChange={onIncludeChange}
        bulkSelectable={bulkSelectable}
      />
    </>
  );
}

/**
 * 계산서에서 채우기 칸. 고른 값(승인 때 실을 보강 값)이 바뀔 때마다 `onSelectedChange` 로
 * 카드에 알린다 — 승인 버튼은 카드가 갖고 있기 때문이다. 저장하지 않기로 하면 `undefined`.
 *
 * @param bulkSelectable 카드에 일괄 선택 체크가 있는가. 일괄 승인은 보강 값을 싣지 않으므로 안내한다.
 */
export function PartnerInvoiceEnrichment({
  proposalId,
  onSelectedChange,
  bulkSelectable = false,
}: {
  proposalId: string;
  onSelectedChange: (enrichment: PartnerEnrichment | undefined) => void;
  bulkSelectable?: boolean;
}) {
  const [data, setData] = React.useState<PartnerInvoiceLookupResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [include, setInclude] = React.useState(false);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 찾는 중·오류일 때는 저장할 값이 없다 — 이전 결과를 화면에 남겨 둬도 승인에는 싣지 않는다.
  const fills = data && !loading && !error ? data.plan?.fills : undefined;
  const selected = include && fills && Object.keys(fills).length > 0 ? fills : undefined;
  // 레이아웃 효과로 알린다 — 결과가 화면에 그려지는 **같은 커밋**에 카드의 승인 값이 바뀌어야,
  // 결과를 보자마자 누른 승인이 이전 값(없음)으로 나가지 않는다(일반 효과는 그림 뒤에 돈다).
  React.useLayoutEffect(() => {
    onSelectedChange(selected);
  }, [selected, onSelectedChange]);
  // 칸이 사라지면(상태 전환 등) 카드에 남은 값도 지운다.
  React.useLayoutEffect(() => () => onSelectedChange(undefined), [onSelectedChange]);

  const search = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchLookup(proposalId);
      if (!mountedRef.current) return;
      setData(next);
      setInclude(defaultInclude(next));
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "계산서를 찾지 못했습니다.");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const status = loading
    ? "메일함을 읽는 중입니다. 수십 초 걸릴 수 있습니다."
    : data === null && error === null
      ? "메일함 계산서에서 대표자·주소·업태·종목·이메일을 찾아 보여 줍니다. 승인할 때 기안의 빈 칸만 채웁니다."
      : null;

  return (
    <section
      aria-label="계산서에서 채우기"
      className="space-y-2 rounded-md border border-border bg-muted/30 p-2 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-foreground">계산서에서 채우기</p>
        <Button type="button" size="xs" variant="outline" onClick={search} disabled={loading}>
          {loading ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
          {data === null && error === null ? "계산서에서 찾기" : "다시 찾기"}
        </Button>
      </div>

      {/* 늘 있는 상자에 안내를 바꿔 넣는다 — 조건부로 마운트하면 화면낭독기가 읽지 않는다. */}
      <p className="text-muted-foreground empty:hidden" aria-live="polite">
        {status}
      </p>

      {error && (
        <p role="alert" className="text-status-caution-text">
          {error} 이 기안은 그대로 승인할 수 있습니다.
        </p>
      )}
      {data && (
        // 다시 찾는 동안 이전 결과를 흐리게 남겨 높이가 흔들리지 않게 한다.
        <div className={cn("space-y-2", loading && "opacity-50")}>
          <Result
            data={data}
            include={include}
            onIncludeChange={setInclude}
            bulkSelectable={bulkSelectable}
          />
        </div>
      )}
    </section>
  );
}
