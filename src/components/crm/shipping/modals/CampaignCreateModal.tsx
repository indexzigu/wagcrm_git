import React, { useState, useEffect, useMemo } from 'react';
import { Package, RotateCcw, X } from 'lucide-react';
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConfirmActionDialog } from "@/components/crm/confirm-action-dialog";
import { sortProductMappingsByProductName } from '@/lib/order-converter/product-mapping-sort';
import { deriveOrderCampaignFieldsFromProduct } from '@/lib/order-converter/order-campaign-create';
import { brandEmailsFor, toOrderBrandOptions, type OrderBrandOption } from '@/lib/order-converter/order-brand-option';

type CampaignCreateModalProps = {
  selectedProduct: any;
  onClose: () => void;
  onReselectProduct: () => void;
  onSubmit: (data: any) => Promise<void>;
};

export default function CampaignCreateModal({
  selectedProduct,
  onClose,
  onReselectProduct,
  onSubmit,
}: CampaignCreateModalProps) {
  const [newName, setNewName] = useState('');
  const [newSellerName, setNewSellerName] = useState('');
  const [newTemplate, setNewTemplate] = useState('');
  const [newToEmail, setNewToEmail] = useState('');
  const [newCcEmail, setNewCcEmail] = useState('');
  const [newThumbnailUrl, setNewThumbnailUrl] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newProductStatus, setNewProductStatus] = useState('');
  const [newSalePeriod, setNewSalePeriod] = useState('');
  const [mappings, setMappings] = useState([{ productName: '', optionName: '', brandCode: '', price: 0 }]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const [loadOptionsError, setLoadOptionsError] = useState<string | null>(null);
  const [brandOptions, setBrandOptions] = useState<OrderBrandOption[]>([]);
  const [brandLoadError, setBrandLoadError] = useState(false);
  const [brandsLoaded, setBrandsLoaded] = useState(false);

  // F4-②: '거래처 양식' 드롭다운을 거래처 발주 설정에서 동적 로드 (하드코딩 제거)
  useEffect(() => {
    let cancelled = false;
    fetch('/order-converter/api/brands')
      .then(r => { if (!r.ok) throw new Error('발주 브랜드 목록 조회 실패'); return r.json(); })
      .then(d => { if (!cancelled && Array.isArray(d.brands)) setBrandOptions(toOrderBrandOptions(d.brands)); })
      .catch(() => { if (!cancelled) setBrandLoadError(true); })
      .finally(() => { if (!cancelled) setBrandsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // 현재 선택값이 목록에 없으면 병합해 노출(선택 유지). 로드 전에는 원시 코드 대신 '불러오는 중…'.
  const templateOptions = useMemo(() => {
    const opts = brandOptions.slice();
    if (newTemplate && !opts.some(o => o.slug === newTemplate)) {
      opts.unshift({ slug: newTemplate, displayName: brandsLoaded ? newTemplate : '불러오는 중…', toEmail: null, ccEmail: null });
    }
    return opts;
  }, [brandOptions, newTemplate, brandsLoaded]);

  // F4-②: 브랜드 선택 시 거래처의 수신/참조 이메일을 캠페인에 상속(자동 채움).
  const handleBrandChange = (slug: string) => {
    setNewTemplate(slug);
    const emails = brandEmailsFor(brandOptions, slug);
    if (emails.toEmail) setNewToEmail(emails.toEmail);
    if (emails.ccEmail !== undefined) setNewCcEmail(emails.ccEmail);
  };

  // 코드표 없는 거래처용: 선택한 스토어 상품의 옵션명·가격(추가구성 포함)을 매핑 표에 자동 로드.
  // 상품코드는 비워둔다(미기입 운영). 기존 표에 입력된 내용이 있으면 확인 창으로 대체 여부를 묻는다.
  const fetchStoreOptions = async () => {
    const channelProductNo = selectedProduct?.channelProducts?.[0]?.channelProductNo;
    if (!channelProductNo) {
      setLoadOptionsError('선택된 상품의 채널상품번호를 찾을 수 없습니다.');
      return;
    }

    setIsLoadingOptions(true);
    setLoadOptionsError(null);
    try {
      const res = await fetch(`/order-converter/api/naver/products/${channelProductNo}/options`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '옵션 조회에 실패했습니다.');
      setMappings(sortProductMappingsByProductName(data.rows));
    } catch (err: any) {
      setLoadOptionsError(err?.message || '옵션 조회 중 오류가 발생했습니다.');
    } finally {
      setIsLoadingOptions(false);
      // 실패 시 창을 닫고 시트 내부 loadOptionsError(role="alert")로 오류를 안내한다.
      setConfirmReplaceOpen(false);
    }
  };

  const handleLoadStoreOptions = () => {
    const channelProductNo = selectedProduct?.channelProducts?.[0]?.channelProductNo;
    if (!channelProductNo) {
      setLoadOptionsError('선택된 상품의 채널상품번호를 찾을 수 없습니다.');
      return;
    }
    const hasContent = mappings.some(m => m.optionName || m.brandCode || m.price > 0);
    if (hasContent) {
      setConfirmReplaceOpen(true);
      return;
    }
    void fetchStoreOptions();
  };

  useEffect(() => {
    if (selectedProduct) {
      // 상품 → 칸 파생은 봇 기안과 같은 본체(`deriveOrderCampaignFieldsFromProduct`)를 쓴다.
      const fields = deriveOrderCampaignFieldsFromProduct(selectedProduct);
      setNewName(fields.name);
      setNewSellerName(fields.sellerName);
      setNewThumbnailUrl(fields.thumbnailUrl);
      setNewCategory(fields.category);
      setNewProductStatus(fields.productStatus);
      setNewSalePeriod(fields.salePeriod);
      setMappings([{ productName: fields.name, optionName: '', brandCode: '', price: 0 }]);
    }
  }, [selectedProduct]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit({
        name: newName,
        template: newTemplate,
        sellerName: newSellerName,
        toEmail: newToEmail,
        ccEmail: newCcEmail,
        thumbnailUrl: newThumbnailUrl,
        category: newCategory,
        productStatus: newProductStatus,
        salePeriod: newSalePeriod,
        productId: deriveOrderCampaignFieldsFromProduct(selectedProduct).productId,
        mappings: sortProductMappingsByProductName(mappings.filter(m => m.productName || m.optionName || m.brandCode))
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTablePaste = (
    e: React.ClipboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const pasteData = e.clipboardData.getData('text');
    if (!pasteData) return;
    
    const rows = pasteData.split(/\r?\n/).filter(r => r.trim() !== '');
    if (rows.length === 0) return;
    
    if (rows.length > 1 || rows[0].includes('\t')) {
      e.preventDefault();
      const newMappings = mappings.map(m => ({ ...m }));
      let lastProductName = rowIndex > 0 && newMappings[rowIndex - 1] ? newMappings[rowIndex - 1].productName : '';
      
      rows.forEach((row, rIdx) => {
        const cols = row.split('\t');
        const targetRowIdx = rowIndex + rIdx;
        
        if (targetRowIdx >= newMappings.length) {
          newMappings.push({ productName: '', optionName: '', brandCode: '', price: 0 });
        }
        
        const targetRow = newMappings[targetRowIdx];
        
        if (colIndex <= 0 && cols[0 - colIndex] !== undefined) {
          const pastedName = cols[0 - colIndex].trim();
          if (pastedName) {
            targetRow.productName = pastedName;
            lastProductName = pastedName;
          } else {
            targetRow.productName = lastProductName;
          }
        }
        if (colIndex <= 1 && cols[1 - colIndex] !== undefined) {
          let optName = cols[1 - colIndex].trim();
          optName = optName.replace(/제품:\s*/g, '');
          optName = optName.replace(/\/?\s*수량:\s*/g, '/ ');
          optName = optName.replace(/\[\d+%\]\s*/g, '');
          optName = optName.replace(/^\/\s*/, '');
          targetRow.optionName = optName;
        }
        if (colIndex <= 2 && cols[2 - colIndex] !== undefined) targetRow.brandCode = cols[2 - colIndex].trim();
        if (colIndex <= 3 && cols[3 - colIndex] !== undefined) {
          const parsedPrice = parseInt(cols[3 - colIndex].replace(/,/g, ''), 10);
          targetRow.price = isNaN(parsedPrice) ? 0 : parsedPrice;
        }
      });
      setMappings(sortProductMappingsByProductName(newMappings));
    }
  };

  if (!selectedProduct) return null;

  const cp = selectedProduct.channelProducts?.[0] || {};
  const stockQuantity = selectedProduct.originProduct?.stockQuantity ?? cp.stockQuantity ?? 0;

  return (
    <Sheet open={!!selectedProduct} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        style={{ width: "min(640px, 96vw)", maxWidth: "min(640px, 96vw)" }}
        className="flex flex-col h-full overflow-hidden border-l border-border bg-card p-0 gap-0"
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 border-b border-slate-100 flex flex-row justify-between items-center bg-white px-5 py-4 gap-0">
          <SheetTitle className="font-bold text-lg text-slate-800">신규 캠페인 등록</SheetTitle>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onReselectProduct}
              className="gap-1.5 font-bold text-slate-600"
            >
              상품 다시 선택
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="닫기"
              className="rounded-full text-slate-500 hover:text-slate-700"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] p-5">
          <form onSubmit={handleSubmit} className="space-y-4 animate-in fade-in">
            {/* 상품 요약은 정보 표면이라 무채색(P8 §1·§4) — 강조는 굵기로. 이 창에서 파랑은 저장 버튼·입력 포커스 같은
                상호작용 색에만 남는다. 값 줄은 알파 글자 대신 slate-700(3차 글자 규칙). */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex gap-4 items-center">
              {newThumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={newThumbnailUrl} alt="썸네일" className="w-16 h-16 rounded-lg object-cover border border-slate-200 shadow-soft-sm" />
              )}
              <div className="flex-1">
                <p className="text-sm text-slate-900 font-bold mb-1 line-clamp-1">{newName}</p>
                {/* 카테고리·판매기간 칩은 필드 이름표라 상태 의미가 없다 — 회색 칩(slate-100 위 slate-600, 6.90)으로 둔다
                    (P8 §4). 종전 blue·indigo 두 색은 같은 역할에 서로 다른 hue 였다. */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700 mt-2 bg-card p-2 rounded-md">
                  <span className="flex items-center gap-1 font-medium"><span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-bold">카테고리</span> {newCategory}</span>
                  <span className="flex items-center gap-1 font-medium"><span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600 font-bold">판매기간</span> {newSalePeriod}</span>
                  <span className="flex items-center gap-1 font-medium">
                    <Package className="size-3.5 text-slate-500" aria-hidden="true" />
                    재고: <b>{stockQuantity.toLocaleString()}개</b>
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <div className="col-span-2">
                <label htmlFor="campaign-create-name" className="block text-xs font-bold text-slate-600 mb-1.5">캠페인(상품)명 (자동입력)</label>
                <input id="campaign-create-name" required readOnly value={newName} className="w-full border border-slate-200 bg-slate-50 text-slate-900 rounded-xl p-3 text-sm font-medium focus:outline-none shadow-soft-sm" />
              </div>
              <div>
                <label htmlFor="campaign-template-create" className="block text-xs font-bold text-slate-600 mb-1.5">거래처 양식</label>
                <select id="campaign-template-create" value={newTemplate} onChange={e => handleBrandChange(e.target.value)} className="w-full border border-slate-200 rounded-xl p-3 text-sm bg-white text-slate-900 focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow] shadow-soft-sm">
                  <option value="" disabled={templateOptions.length > 0}>
                    {templateOptions.length === 0
                      ? (brandLoadError ? '목록을 불러오지 못했습니다. 새로고침' : '발주 브랜드 없음 (거래처에서 수신 이메일 설정)')
                      : '거래처(브랜드) 선택'}
                  </option>
                  {templateOptions.map(o => (
                    <option key={o.slug} value={o.slug}>{o.displayName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="campaign-create-seller" className="block text-xs font-bold text-slate-600 mb-1.5">셀러명 (메일 본문 식별용)</label>
                <input id="campaign-create-seller" required value={newSellerName} onChange={e => setNewSellerName(e.target.value)} className="w-full border border-slate-200 rounded-xl p-3 text-sm bg-white text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow] shadow-soft-sm" placeholder="예: 와이그라운드(김본명)" />
              </div>
              <div className="col-span-1">
                <label htmlFor="campaign-create-to" className="block text-xs font-bold text-slate-600 mb-1.5">수신 이메일 주소</label>
                <input id="campaign-create-to" required value={newToEmail} onChange={e => setNewToEmail(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow] shadow-soft-sm" placeholder="예: order@example.com" />
              </div>
              <div className="col-span-1">
                <label htmlFor="campaign-create-cc" className="block text-xs font-bold text-slate-600 mb-1.5">참조 이메일 주소 (선택)</label>
                <input id="campaign-create-cc" value={newCcEmail} onChange={e => setNewCcEmail(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow] shadow-soft-sm" placeholder="예: cc@example.com" />
              </div>
              
              <div className="col-span-2 mt-2">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-xs font-bold text-slate-500">상품 매핑 표 (코드표 붙여넣기 또는 스토어 옵션 자동 로드 · 상품코드는 코드표 없으면 비워둠)</label>
                  <div className="flex gap-1.5">
                    <Button type="button" variant="outline" size="xs" onClick={handleLoadStoreOptions} disabled={isLoadingOptions}>
                      {isLoadingOptions ? '동기화 중...' : 'N스토어 동기화'}
                    </Button>
                    <Button type="button" variant="secondary" size="xs" onClick={() => setMappings([...mappings, { productName: '', optionName: '', brandCode: '', price: 0 }])}>
                      + 행 추가
                    </Button>
                  </div>
                </div>
                {loadOptionsError && (
                  <p role="alert" className="text-xs text-destructive font-medium mb-2">{loadOptionsError}</p>
                )}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-bold">상품명</th>
                        <th className="px-3 py-2 font-bold">옵션명</th>
                        <th className="px-3 py-2 font-bold">상품코드</th>
                        <th className="px-3 py-2 font-bold w-24">단가</th>
                        <th className="px-3 py-2 font-bold w-12 text-center">삭제</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mappings.map((m, idx) => (
                        <tr key={idx} className="bg-white hover:bg-slate-50">
                          <td className="px-2 py-1.5">
                            <input value={m.productName} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], productName: e.target.value }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 0)} aria-label={`${idx + 1}행 상품명`}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow]" placeholder="상품명 일부" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={m.optionName} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], optionName: e.target.value }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 1)} aria-label={`${idx + 1}행 옵션명`}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow]" placeholder="옵션명 일부" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={m.brandCode} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], brandCode: e.target.value }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 2)} aria-label={`${idx + 1}행 상품코드`}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow]" placeholder="매핑 코드" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input type="number" value={m.price} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], price: Number(e.target.value) }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 3)} aria-label={`${idx + 1}행 단가`}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-primary outline-none transition-[border-color,box-shadow]" />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button
                              type="button"
                              disabled={mappings.length <= 1}
                              onClick={() => {
                                if (mappings.length > 1) setMappings(mappings.filter((_, i) => i !== idx));
                              }}
                              aria-label={`${idx + 1}행 삭제`}
                              className="inline-flex size-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              <X className="size-4" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-slate-100">
              <Button type="button" variant="outline" onClick={onClose}>취소</Button>
              <Button type="submit" disabled={isSubmitting}>{isSubmitting ? '저장 중...' : '저장하기'}</Button>
            </div>
          </form>
        </div>
      </SheetContent>
      <ConfirmActionDialog
        open={confirmReplaceOpen}
        onOpenChange={setConfirmReplaceOpen}
        title="매핑 표를 스토어 옵션으로 대체할까요?"
        description="현재 입력된 매핑 표 내용이 스마트스토어 옵션으로 덮어쓰여집니다."
        confirmLabel="스토어 옵션으로 대체"
        pendingLabel="불러오는 중..."
        loading={isLoadingOptions}
        onConfirm={fetchStoreOptions}
      />
    </Sheet>
  );
}
