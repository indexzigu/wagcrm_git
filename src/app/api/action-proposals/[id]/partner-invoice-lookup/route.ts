import { NextResponse } from "next/server";
import { requireRole } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { parseStoredJson } from "@/lib/stored-json";
import { ActionProposalRepository } from "@/repositories/actionProposalRepository";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { scanTaxInvoiceMails } from "@/lib/tax-invoice-mail/mail-scan";
import { findPartnerInvoiceInfo } from "@/lib/tax-invoice-mail/partner-invoice-lookup";
import { planPartnerEnrichment } from "@/lib/agent/partner-enrichment";
import { isAcceptableEnrichmentValue } from "@/lib/agent/partner-enrichment-schema";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * 메일함을 거슬러 올라가는 기간(일). 거래처 등록은 첫 거래 직후에 하는 일이라 반년이면
 * 대개 계산서가 있다. 수취 대조 화면(최대 365일)보다 좁게 둬 승인 화면의 대기를 줄인다.
 */
const PARTNER_INVOICE_LOOKUP_SINCE_DAYS = 180;

/** 승인 전 상태만 찾는다 — 실행이 끝난 기안을 보강해도 저장할 길이 없다. */
const LOOKUP_STATUSES = new Set(["PENDING_APPROVAL", "FAILED"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** 같은 사업자번호로 이미 등록된 거래처 — 있으면 이 기안은 중복 등록일 수 있다. */
async function findExistingPartner(businessNumber: string | null) {
  const target = digitsOf(businessNumber);
  if (target.length !== 10) return null;
  const partners = await getPrisma().partner.findMany({
    where: { businessNumber: { not: null } },
    select: { id: true, name: true, businessNumber: true },
  });
  const match = partners.find((partner) => digitsOf(partner.businessNumber) === target);
  return match ? { id: match.id, name: match.name } : null;
}

/**
 * GET /api/action-proposals/[id]/partner-invoice-lookup
 *
 * 「거래처 등록」 기안 하나에 맞는 계산서를 메일함(읽기 전용)에서 찾아, 승인 때 함께 저장할
 * 사업자 정보를 돌려준다. **아무것도 쓰지 않는다** — 저장은 승인(`../approve`)이 보강 값을
 * 받아 한 트랜잭션에서 한다(`approve-proposal.ts`).
 *
 * ⛔ 응답에 대표자·주소·이메일이 있다 — admin 전용 결재 화면만 쓴다. 봇·슬랙 경로로 내보내지 말 것.
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const proposal = await ActionProposalRepository.findById(id);
  if (!proposal) {
    return NextResponse.json({ error: "해당 기안을 찾을 수 없습니다." }, { status: 404 });
  }

  const payload = parseStoredJson<{ action?: string; args?: Record<string, unknown> }>(proposal.payload);
  const partner = asRecord(payload?.args?.partner);
  if (payload?.action !== "create_partner" || !partner) {
    return NextResponse.json({ error: "거래처 등록 기안이 아닙니다." }, { status: 400 });
  }
  if (!LOOKUP_STATUSES.has(proposal.status)) {
    return NextResponse.json(
      { error: "승인 대기 중인 기안만 계산서에서 채울 수 있습니다." },
      { status: 409 },
    );
  }

  let scan;
  try {
    scan = await scanTaxInvoiceMails({
      sinceDays: PARTNER_INVOICE_LOOKUP_SINCE_DAYS,
      // 국세청 보안메일 첨부의 비밀번호 = 공급받는자(우리) 사업자등록번호(수취 조회 라우트와 같다).
      invoicePassword: SUPPLIER.businessNumber,
    });
  } catch (error) {
    // 삼키지 않는다 — 조회 실패를 「계산서 없음」으로 보이면 오너가 빈 칸으로 승인한다(P0).
    const message = error instanceof Error ? error.message : "메일함 조회에 실패했습니다.";
    console.error(`[partner-invoice-lookup ${id}] 메일함 조회 실패:`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const name = typeof partner.name === "string" ? partner.name : "";
  const businessNumber = typeof partner.businessNumber === "string" ? partner.businessNumber : null;
  const lookup = findPartnerInvoiceInfo({
    mails: scan.mails,
    ourBusinessNumber: SUPPLIER.businessNumber,
    target: { name, businessNumber },
  });
  const plan =
    lookup.status === "FOUND"
      ? planPartnerEnrichment(partner, lookup.values, isAcceptableEnrichmentValue)
      : null;
  const existingPartner = await findExistingPartner(
    lookup.status === "FOUND" ? lookup.counterpart.businessNumber : businessNumber,
  );

  return NextResponse.json({
    lookup,
    plan,
    existingPartner,
    scan: {
      sinceDays: PARTNER_INVOICE_LOOKUP_SINCE_DAYS,
      mailsRead: scan.mails.length,
      // 상한에 걸려 못 읽은 통수 — 0 이 아니면 「없음」이 「전부 봤다」는 뜻이 아니다.
      truncated: scan.truncated,
    },
  });
}
