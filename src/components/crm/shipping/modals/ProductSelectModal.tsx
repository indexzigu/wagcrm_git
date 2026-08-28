import React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type ProductSelectModalProps = {
  isOpen: boolean;
  naverProducts: any[];
  isFetchingNaver: boolean;
  onFetchProducts: () => void;
  onSelectProduct: (product: any) => void;
  onClose: () => void;
};

export default function ProductSelectModal({
  isOpen,
  naverProducts,
  isFetchingNaver,
  onFetchProducts,
  onSelectProduct,
  onClose,
}: ProductSelectModalProps) {
  const getProductStatusBadge = (status: string) => {
    const baseClass = "text-[9px] px-1.5 py-0.5 rounded font-bold whitespace-nowrap border";
    switch(status) {
      case 'SALE':
        return <span className={`${baseClass} bg-status-success-bg text-status-success border-status-success/20`}>판매중</span>;
      case 'OUTOFSTOCK':
        return <span className={`${baseClass} bg-transparent text-foreground border-border`}>품절</span>;
      case 'SUSPENDED':
      case 'SUSPENSION':
        return <span className={`${baseClass} bg-transparent text-foreground border-border`}>판매중지</span>;
      case 'CLOSE':
        return <span className={`${baseClass} bg-transparent text-foreground border-border`}>판매종료</span>;
      case 'WAIT':
        return <span className={`${baseClass} bg-transparent text-foreground border-border`}>대기</span>;
      default:
        return <span className={`${baseClass} bg-transparent text-foreground border-border`}>{status || '상태없음'}</span>;
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        style={{ width: "min(640px, 96vw)", maxWidth: "min(640px, 96vw)" }}
        className="flex flex-col h-full overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0 gap-0"
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 border-b border-slate-100 flex flex-row justify-between items-center bg-white px-5 py-4 gap-0">
          <SheetTitle className="text-lg font-bold text-slate-800">네이버 스토어 상품 조회</SheetTitle>
          <div className="flex items-center gap-2">
            <button 
              onClick={onFetchProducts} 
              disabled={isFetchingNaver} 
              className="flex items-center gap-1.5 text-xs font-bold text-slate-600 bg-white hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 shadow-soft-sm border border-slate-200"
            >
              <svg className={`w-3.5 h-3.5 ${isFetchingNaver ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {isFetchingNaver ? "불러오는 중..." : "새로고침"}
            </button>
            <button 
              onClick={onClose} 
              className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </SheetHeader>
        
        <div className="flex-1 overflow-y-auto bg-slate-50 p-5">
          {isFetchingNaver && naverProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3">
              <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-500 rounded-full animate-spin"></div>
              <p className="text-sm font-bold">상품 정보를 불러오는 중입니다...</p>
            </div>
          ) : naverProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500">
              <p className="text-sm font-bold">조회된 상품이 없습니다.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-xs font-bold text-slate-500 mb-2 px-1">총 {naverProducts.length}건</div>
              {naverProducts.map((p, i) => {
                const cp = p.channelProducts?.[0];
                if (!cp) return null;
                const prodName = cp.name || '알수없는 상품명';
                const status = cp.statusType || 'WAIT';
                const thumb = cp.representativeImage?.url;
                
                const formatDt = (dtStr: string) => dtStr ? dtStr.split('T')[0].replace(/-/g, '.') : '';
                let dateStr = '기간 미정';
                if (cp.saleStartDate && cp.saleEndDate) {
                  const start = new Date(cp.saleStartDate);
                  const end = new Date(cp.saleEndDate);
                  const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                  if (['WAIT', 'SUSPENDED', 'OUTOFSTOCK'].includes(status) && diffDays >= 13 && diffDays <= 15) {
                    dateStr = '미등록';
                  } else {
                    dateStr = `${formatDt(cp.saleStartDate)} ~ ${formatDt(cp.saleEndDate)}`;
                  }
                } else if (cp.saleStartDate) {
                  dateStr = `${formatDt(cp.saleStartDate)} ~ 계속`;
                }

                const categoryName = cp.wholeCategoryName?.split('>').pop() || p.originProduct?.category?.name || p.category?.name || '카테고리 미지정';
                const stockQuantity = p.originProduct?.stockQuantity ?? cp.stockQuantity ?? 0;

                const getCardBgStyle = (status: string) => {
                  switch (status) {
                    case 'SALE': return 'bg-status-success-bg/30 border-slate-200 hover:border-status-success/40';
                    case 'OUTOFSTOCK':
                    case 'SUSPENDED':
                    case 'SUSPENSION':
                    case 'CLOSE': return 'bg-slate-100/50 border-slate-200/80 hover:border-slate-400';
                    case 'WAIT': return 'bg-status-caution-bg/40 border-slate-200 hover:border-status-caution/40';
                    default: return 'bg-white border-slate-200 hover:border-blue-400';
                  }
                };
                const bgStyle = getCardBgStyle(status);

                return (
                  <button 
                    key={i}
                    onClick={() => onSelectProduct(p)}
                    className={`w-full ${bgStyle} border rounded-2xl p-4 flex gap-4 text-left hover:shadow-soft-md transition-shadow group`}
                  >
                    <div className="w-20 h-20 bg-slate-100 rounded-xl overflow-hidden flex-shrink-0 border border-slate-200">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt={prodName} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">No Img</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
                      <h4 className="font-bold text-sm text-slate-800 line-clamp-1 leading-snug min-w-0">{prodName}</h4>
                      
                      <div className="flex justify-between items-center gap-3">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-bold whitespace-nowrap border border-slate-200">카테고리</span>
                          <span className="text-[11px] text-slate-500 truncate leading-none">{categoryName}</span>
                        </div>
                        {getProductStatusBadge(status)}
                      </div>
                      
                      <div className="flex justify-between items-center text-[11px] text-slate-500 font-medium">
                        <div className="flex items-center gap-1 min-w-0">
                          <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          <span className="truncate">{dateStr}</span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                          <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                          </svg>
                          <span className={stockQuantity < 50 ? 'text-red-500' : ''}>재고: {stockQuantity.toLocaleString()}개</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
