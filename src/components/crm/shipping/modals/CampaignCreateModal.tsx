import React, { useState, useEffect, useMemo } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { sortProductMappingsByProductName } from '@/lib/order-converter/product-mapping-sort';

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
  const [loadOptionsError, setLoadOptionsError] = useState<string | null>(null);
  const [brandOptions, setBrandOptions] = useState<{ slug: string; displayName: string; toEmail: string | null; ccEmail: string | null }[]>([]);
  const [brandLoadError, setBrandLoadError] = useState(false);
  const [brandsLoaded, setBrandsLoaded] = useState(false);

  // F4-②: '거래처 양식' 드롭다운을 거래처 발주 설정에서 동적 로드 (하드코딩 제거)
  useEffect(() => {
    let cancelled = false;
    fetch('/order-converter/api/brands')
      .then(r => { if (!r.ok) throw new Error('발주 브랜드 목록 조회 실패'); return r.json(); })
      .then(d => { if (!cancelled && Array.isArray(d.brands)) setBrandOptions(d.brands.map((b: any) => ({ slug: b.slug, displayName: b.displayName, toEmail: b.toEmail ?? null, ccEmail: b.ccEmail ?? null }))); })
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
    const brand = brandOptions.find(b => b.slug === slug);
    if (brand?.toEmail) setNewToEmail(brand.toEmail);
    if (brand?.ccEmail) setNewCcEmail(brand.ccEmail);
  };

  // 코드표 없는 거래처용: 선택한 스토어 상품의 옵션명·가격(추가구성 포함)을 매핑 표에 자동 로드.
  // 상품코드는 비워둔다(미기입 운영). 기존 표에 입력된 내용이 있으면 대체 여부를 확인한다.
  const handleLoadStoreOptions = async () => {
    const channelProductNo = selectedProduct?.channelProducts?.[0]?.channelProductNo;
    if (!channelProductNo) {
      setLoadOptionsError('선택된 상품의 채널상품번호를 찾을 수 없습니다.');
      return;
    }
    const hasContent = mappings.some(m => m.optionName || m.brandCode || m.price > 0);
    if (hasContent && !window.confirm('현재 매핑 표 내용을 스토어 옵션으로 대체할까요?')) return;

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
    }
  };

  useEffect(() => {
    if (selectedProduct) {
      const cp = selectedProduct.channelProducts?.[0];
      const name = cp?.name || selectedProduct.name || selectedProduct.originProduct?.name || '알수없는 상품명';
      const thumb = cp?.representativeImage?.url || '';
      const categoryName = cp?.wholeCategoryName?.split('>').pop() || selectedProduct.originProduct?.category?.name || selectedProduct.category?.name || '카테고리 미지정';
      
      let extractedSellerName = '';
      const match = name.match(/^\[(.*?) X .*?\]/);
      if (match && match[1]) {
        extractedSellerName = match[1].trim();
      }

      const formatDt = (dtStr: string) => dtStr ? dtStr.split('T')[0].replace(/-/g, '.') : '';
      let dateStr = '기간 미정';
      const status = cp?.statusType || 'WAIT';
      if (cp?.saleStartDate && cp?.saleEndDate) {
        const start = new Date(cp.saleStartDate);
        const end = new Date(cp.saleEndDate);
        const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        if (['WAIT', 'SUSPENDED', 'OUTOFSTOCK'].includes(status) && diffDays >= 13 && diffDays <= 15) {
          dateStr = '미등록';
        } else {
          dateStr = `${formatDt(cp.saleStartDate)} ~ ${formatDt(cp.saleEndDate)}`;
        }
      } else if (cp?.saleStartDate) {
        dateStr = `${formatDt(cp.saleStartDate)} ~ 계속`;
      }
      
      setNewName(name);
      setNewSellerName(extractedSellerName);
      setNewThumbnailUrl(thumb);
      setNewCategory(categoryName);
      setNewProductStatus(status);
      setNewSalePeriod(dateStr);
      setMappings([{ productName: name, optionName: '', brandCode: '', price: 0 }]);
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
        productId: cp?.originProductNo?.toString() || cp?.productNo?.toString() || selectedProduct.originProduct?.productNo?.toString() || '',
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
        className="flex flex-col h-full overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0 gap-0"
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 border-b border-slate-100 flex flex-row justify-between items-center bg-white px-5 py-4 gap-0">
          <SheetTitle className="font-bold text-lg text-slate-800">신규 캠페인 등록</SheetTitle>
          <div className="flex gap-2">
            <button 
              type="button" 
              onClick={onReselectProduct}
              className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1.5 font-bold border border-slate-200 px-2.5 py-1.5 rounded-md hover:bg-slate-50 transition-colors"
            >
              상품 다시 선택 <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            </button>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5">
          <form onSubmit={handleSubmit} className="space-y-4 animate-in fade-in">
            <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-4 flex gap-4 items-center">
              {newThumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={newThumbnailUrl} alt="썸네일" className="w-16 h-16 rounded-lg object-cover border border-blue-200 shadow-soft-sm" />
              )}
              <div className="flex-1">
                <p className="text-sm text-blue-900 font-bold mb-1 line-clamp-1">{newName}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-blue-800/80 mt-2 bg-white/60 p-2 rounded-md">
                  <span className="flex items-center gap-1 font-medium"><span className="text-[10px] bg-blue-100 px-1.5 py-0.5 rounded text-blue-600 font-bold">카테고리</span> {newCategory}</span>
                  <span className="flex items-center gap-1 font-medium"><span className="text-[10px] bg-indigo-100 px-1.5 py-0.5 rounded text-indigo-600 font-bold">판매기간</span> {newSalePeriod}</span>
                  <span className="flex items-center gap-1 font-medium">
                    <svg className="w-3.5 h-3.5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                    재고: <b>{stockQuantity.toLocaleString()}개</b>
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <div className="col-span-2">
                <label className="block text-xs font-bold text-slate-600 mb-1.5">캠페인(상품)명 (자동입력)</label>
                <input required readOnly value={newName} className="w-full border border-slate-200 bg-slate-50 text-slate-900 rounded-xl p-3 text-sm font-medium focus:outline-none shadow-soft-sm" />
              </div>
              <div>
                <label htmlFor="campaign-template-create" className="block text-xs font-bold text-slate-600 mb-1.5">거래처 양식</label>
                <select id="campaign-template-create" value={newTemplate} onChange={e => handleBrandChange(e.target.value)} className="w-full border border-slate-200 rounded-xl p-3 text-sm bg-white text-slate-900 focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm">
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
                <label className="block text-xs font-bold text-slate-600 mb-1.5">셀러명 (메일 본문 식별용)</label>
                <input required value={newSellerName} onChange={e => setNewSellerName(e.target.value)} className="w-full border border-slate-200 rounded-xl p-3 text-sm bg-white text-slate-900 placeholder-slate-400 focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm" placeholder="예: 와이그라운드(김본명)" />
              </div>
              <div className="col-span-1">
                <label className="block text-xs font-bold text-slate-600 mb-1.5">수신 이메일 주소</label>
                <input required value={newToEmail} onChange={e => setNewToEmail(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm" placeholder="예: order@example.com" />
              </div>
              <div className="col-span-1">
                <label className="block text-xs font-bold text-slate-600 mb-1.5">참조 이메일 주소 (선택)</label>
                <input value={newCcEmail} onChange={e => setNewCcEmail(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm" placeholder="예: cc@example.com" />
              </div>
              
              <div className="col-span-2 mt-2">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-xs font-bold text-slate-500">상품 매핑 표 (코드표 붙여넣기 또는 스토어 옵션 자동 로드 · 상품코드는 코드표 없으면 비워둠)</label>
                  <div className="flex gap-1.5">
                    <button type="button" onClick={handleLoadStoreOptions} disabled={isLoadingOptions} className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-1 rounded hover:bg-emerald-100 font-bold transition-colors disabled:opacity-50">
                      {isLoadingOptions ? '동기화 중...' : 'N스토어 동기화'}
                    </button>
                    <button type="button" onClick={() => setMappings([...mappings, { productName: '', optionName: '', brandCode: '', price: 0 }])} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded hover:bg-slate-200 font-bold transition-colors">
                      + 행 추가
                    </button>
                  </div>
                </div>
                {loadOptionsError && (
                  <p className="text-xs text-red-500 font-medium mb-2">{loadOptionsError}</p>
                )}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase">
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
                            }} onPaste={(e) => handleTablePaste(e, idx, 0)}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-400 outline-none transition-[border-color,box-shadow]" placeholder="상품명 일부" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={m.optionName} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], optionName: e.target.value }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 1)}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-400 outline-none transition-[border-color,box-shadow]" placeholder="옵션명 일부" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input value={m.brandCode} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], brandCode: e.target.value }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 2)}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-400 outline-none transition-[border-color,box-shadow]" placeholder="매핑 코드" />
                          </td>
                          <td className="px-2 py-1.5">
                            <input type="number" value={m.price} onChange={(e) => {
                              const newM = [...mappings]; newM[idx] = { ...newM[idx], price: Number(e.target.value) }; setMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 3)}
                            className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-400 outline-none transition-[border-color,box-shadow]" />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button type="button" onClick={() => {
                              if (mappings.length > 1) setMappings(mappings.filter((_, i) => i !== idx));
                            }} className="text-red-400 hover:text-red-600 font-bold p-1"><svg className="w-4 h-4 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-slate-100">
              <button type="button" onClick={onClose} className="px-5 py-2 text-sm text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 font-bold transition-colors">취소</button>
              <button type="submit" disabled={isSubmitting} className="px-5 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 font-bold shadow-soft-md transition-[background-color,opacity] disabled:opacity-50">{isSubmitting ? '저장 중...' : '저장하기'}</button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
