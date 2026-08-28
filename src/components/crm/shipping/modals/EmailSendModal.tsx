import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type StepStatus = 'IDLE' | 'ANALYZING' | 'CONVERTING' | 'CONVERT_DONE' | 'SENDING' | 'SUCCESS';

type EmailSendModalProps = {
  campaignId: string;
  defaultTo?: string;
  defaultCc?: string;
  defaultSubject?: string;
  defaultMessage?: string;
  // 발주서 파일명 기본값(서버 provider 기준으로 order-dashboard가 미리 조합). 자동 연동 파일명 프리뷰용.
  defaultFileName?: string;
  onClose: () => void;
  onSuccess: () => void;
  // 발주요청 감사 로그용 — 발송 성패(성공/실패)와 발주서에 실린 상품주문 수를 상위에 통지한다.
  onResult?: (ok: boolean, errorMessage?: string, fileName?: string, orderCount?: number) => void;
  addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
};

// 사용자가 편집한 파일명에 .xlsx 확장자를 보장한다(빈 값이면 폴백 이름을 그대로 쓰도록 빈 문자열 반환).
function ensureXlsxName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return /\.xlsx$/i.test(trimmed) ? trimmed : `${trimmed}.xlsx`;
}

export default function EmailSendModal({
  campaignId,
  defaultTo = '',
  defaultCc = '',
  defaultSubject = '',
  defaultMessage = '',
  defaultFileName = '',
  onClose,
  onSuccess,
  onResult,
  addToast
}: EmailSendModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [emailToStr, setEmailToStr] = useState(defaultTo);
  const [emailCcStr, setEmailCcStr] = useState(defaultCc);
  const [emailSubject, setEmailSubject] = useState(defaultSubject);
  const [emailMessage, setEmailMessage] = useState(defaultMessage);

  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [includePending, setIncludePending] = useState(false);
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  // 발주서 파일명 — 자동 연동은 서버 조합 기본값, 수동 첨부는 원본 파일명을 기본값으로 하되
  // 사용자가 편집하면(touched) 그 값을 유지한다(원본 그대로 발송 원칙과의 균형).
  const [fileName, setFileName] = useState(defaultFileName);
  const fileNameTouchedRef = useRef(false);
  useEffect(() => {
    if (fileNameTouchedRef.current) return;
    if (mode === 'manual') setFileName(manualFile?.name ?? '');
    else setFileName(defaultFileName);
  }, [mode, manualFile, defaultFileName]);

  const [step, setStep] = useState<StepStatus>('IDLE');
  const [convertedFile, setConvertedFile] = useState<File | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const getStepProgress = () => {
    switch(step) {
      case 'IDLE': return 0;
      case 'ANALYZING': return 25;
      case 'CONVERTING': return 50;
      case 'CONVERT_DONE': return 75;
      case 'SENDING': return 90;
      case 'SUCCESS': return 100;
      default: return 0;
    }
  };

  const handleManualFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setManualFile(file);
    setConvertedFile(null);
    setManualError(null);
    setStep('IDLE');
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step !== 'IDLE') return;
    
    try {
      let finalFile: File | null = convertedFile;
      // 발주서에 실린 상품주문번호(자동 연동 시 execute 응답 헤더로 전달) — 발송 성공 시 배송대기 스탬프용.
      let orderIdsCsv = '';

      if (mode === 'auto') {
        setStep('ANALYZING');
        await new Promise(r => setTimeout(r, 600));

        setStep('CONVERTING');
        const res = await fetch(`/order-converter/api/campaigns/${campaignId}/execute?action=download&includePending=${includePending}`);
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || '발주서 추출에 실패했습니다.');
        }

        orderIdsCsv = res.headers.get('X-YGRD-Order-Ids') || '';
        const blob = await res.blob();
        let filename = `발주서_${campaignId}.xlsx`;
        const contentDisposition = res.headers.get('content-disposition');
        if (contentDisposition) {
          const filenameStarMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
          if (filenameStarMatch && filenameStarMatch[1]) {
            filename = decodeURIComponent(filenameStarMatch[1]);
          } else {
            const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
            if (filenameMatch && filenameMatch[1]) {
              filename = decodeURIComponent(filenameMatch[1]);
            }
          }
        }
        finalFile = new File([blob], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        
        setStep('CONVERT_DONE');
        await new Promise(r => setTimeout(r, 400));
      } else if (mode === 'manual') {
        if (!manualFile) throw new Error('첨부된 파일이 없습니다.');
        // 수동 첨부는 재변환하지 않는다 — 원본 파일을 그대로 발송하되,
        // 발송 전 데이터 정합성 + 캠페인 대조 검증만 수행한다(하드 차단).
        setStep('ANALYZING');
        const formData = new FormData();
        formData.append('file', manualFile);

        const res = await fetch(`/order-converter/api/campaigns/${campaignId}/validate`, {
          method: 'POST',
          body: formData
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(result.error || '검증에 실패했습니다.');
        }
        if (!result.ok) {
          // 검증 실패 → 발송 차단, 모든 사유 표시.
          throw new Error((result.errors && result.errors.length ? result.errors : ['검증에 실패했습니다.']).join('\n'));
        }

        setStep('CONVERT_DONE');
        // 경고(부분 발송/누락 등)는 차단하지 않고 알림만.
        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
          addToast(result.warnings[0], 'info');
        }
        // 원본 파일 그대로 발송. 배송대기 스탬프 대상은 캠페인에 귀속된 주문번호만.
        finalFile = manualFile;
        orderIdsCsv = Array.isArray(result.matchedOrderIds) ? result.matchedOrderIds.join(',') : '';
        await new Promise(r => setTimeout(r, 400));
      }
      
      if (!finalFile) throw new Error('첨부할 변환된 파일이 없습니다.');

      // 사용자가 지정/편집한 파일명이 있으면 첨부 파일명을 그 값으로 교체(수신자에게 보이는 이름).
      // 비어 있으면 원본/서버 파일명을 그대로 유지한다.
      const chosenName = ensureXlsxName(fileName);
      if (chosenName && chosenName !== finalFile.name) {
        finalFile = new File([finalFile], chosenName, { type: finalFile.type });
      }

      setStep('SENDING');
      const formData = new FormData();
      formData.append('file', finalFile);
      formData.append('to', emailToStr);
      if (emailCcStr) formData.append('cc', emailCcStr);
      formData.append('subject', emailSubject);
      formData.append('message', emailMessage);
      formData.append('campaignId', campaignId);
      // 배송대기 스탬프용 상품주문번호(자동 연동 경로에서만 채워짐). 서버가 발송 성공 시 사용.
      if (orderIdsCsv) formData.append('productOrderIds', orderIdsCsv);

      const emailRes = await fetch('/order-converter/api/send-email', { method: 'POST', body: formData });
      if (!emailRes.ok) {
        const errData = await emailRes.json().catch(() => ({}));
        throw new Error(errData.error || '이메일 발송에 실패했습니다.');
      }
      
      setStep('SUCCESS');
      addToast('이메일 발송이 완료되었습니다!', 'success');
      // 발주서에 실린 상품주문 수(감사 로그 성공 건수용). 자동=X-YGRD-Order-Ids, 수동=matchedOrderIds 기반.
      const orderCount = orderIdsCsv ? orderIdsCsv.split(',').filter(Boolean).length : 0;
      onResult?.(true, undefined, finalFile.name, orderCount);

      setTimeout(() => {
        onSuccess();
      }, 1000);

    } catch (error: any) {
      console.error(error);
      onResult?.(false, error?.message);
      if (mode === 'manual') {
        setManualError(error.message);
        setManualFile(null);
      } else {
        addToast(error.message, 'error');
      }
      setStep('IDLE');
    }
  };

  const isBusy = step !== 'IDLE' && step !== 'CONVERT_DONE' && step !== 'SUCCESS';

  if (!isMounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <div 
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" 
        onClick={() => !isBusy && onClose()} 
      />
      <div className="bg-white rounded-2xl shadow-overlay relative w-full max-w-md flex flex-col animate-in fade-in zoom-in-95 duration-200">
        
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-2xl">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg> 
            발주서 첨부 발송
          </h2>
          {!isBusy && (
            <button 
              onClick={onClose} 
              className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        
        <div className="px-5 pt-4 pb-1">
          <div className="relative h-2 w-full bg-slate-100 rounded-full overflow-hidden">
            <div 
              className={`absolute top-0 left-0 h-full w-full origin-left rounded-full transition-[transform,background-color] duration-500 ${step === 'SUCCESS' ? 'bg-green-500' : 'bg-blue-500'}`}
              style={{ transform: `scaleX(${getStepProgress() / 100})` }}
            />
          </div>
          <div className="flex justify-between mt-2 px-1 text-[10px] font-bold text-slate-500 transition-colors">
            <span className={step === 'ANALYZING' ? 'text-blue-600' : step !== 'IDLE' ? 'text-slate-700' : ''}>분석/추출</span>
            <span className={step === 'CONVERTING' ? 'text-blue-600' : ['CONVERT_DONE','SENDING','SUCCESS'].includes(step) ? 'text-slate-700' : ''}>변환</span>
            <span className={step === 'SENDING' ? 'text-blue-600' : step === 'SUCCESS' ? 'text-slate-700' : ''}>발송</span>
            <span className={step === 'SUCCESS' ? 'text-green-600' : ''}>완료</span>
          </div>
        </div>
        
        <form onSubmit={handleSend} className="flex-1 overflow-y-auto">
          <div className="p-5 space-y-4">
            
            <div className="flex items-center justify-between bg-slate-50 border border-slate-100 p-3 rounded-xl min-h-[46px]">
              <span className="text-[11px] text-slate-500 font-medium">
                {mode === 'auto' ? (
                  <>API 연동을 통해 스마트스토어 주문 건을 자동으로 추출합니다.</>
                ) : manualError ? (
                  <span className="flex items-center gap-1.5 text-red-600 font-bold">
                    <svg className="w-4 h-4 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                    <span>{manualError}</span>
                  </span>
                ) : manualFile ? (
                  <span className="flex items-center gap-1.5 text-slate-700">
                    <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                    수동 첨부: <span className="font-bold truncate max-w-[150px] inline-block align-bottom">{manualFile.name}</span>
                  </span>
                ) : (
                  <>수동으로 첨부된 파일이 없습니다. 하단 버튼을 통해 첨부해주세요.</>
                )}
              </span>
            </div>

            {mode === 'auto' && (
              <div className="flex items-center gap-2 mt-2 px-1">
                <input 
                  type="checkbox" 
                  id="includePending" 
                  checked={includePending}
                  onChange={e => setIncludePending(e.target.checked)}
                  disabled={isBusy}
                  className="w-4 h-4 text-blue-600 bg-white border-slate-300 rounded focus:ring-focus-ring focus:ring-2 disabled:opacity-50"
                />
                <label htmlFor="includePending" className="text-xs font-bold text-slate-600 cursor-pointer">
                  배송대기건 포함
                </label>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1.5">발주서 파일명</label>
                <input
                  type="text"
                  value={fileName}
                  onChange={e => { fileNameTouchedRef.current = true; setFileName(e.target.value); }}
                  disabled={isBusy}
                  className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-blue-500 transition-[border-color,box-shadow,opacity] shadow-soft-sm disabled:opacity-50"
                  placeholder="예: 발주서_브랜드_와이그라운드_셀러_250710.xlsx"
                />
                <p className="mt-1 px-1 text-[10px] text-slate-500">
                  {mode === 'manual'
                    ? '첨부한 원본 파일명입니다. 필요하면 수정하세요. (.xlsx 자동 부여)'
                    : '기본값은 거래처 표기명을 따릅니다. 브랜드명 등으로 바꾸려면 수정하세요. (.xlsx 자동 부여)'}
                </p>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1.5">수신 이메일 주소</label>
                <input 
                  required 
                  type="text"
                  value={emailToStr} 
                  onChange={e => setEmailToStr(e.target.value)} 
                  disabled={isBusy}
                  className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-blue-500 transition-[border-color,box-shadow,opacity] shadow-soft-sm disabled:opacity-50" 
                  placeholder="예: target@domain.com, (여러 명일 경우 쉼표로 구분)"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1.5">참조 이메일 주소 (선택)</label>
                <input 
                  type="text"
                  value={emailCcStr} 
                  onChange={e => setEmailCcStr(e.target.value)} 
                  disabled={isBusy}
                  className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-blue-500 transition-[border-color,box-shadow,opacity] shadow-soft-sm disabled:opacity-50" 
                  placeholder="예: cc@domain.com"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1.5">메일 제목</label>
                <input 
                  required 
                  type="text"
                  value={emailSubject} 
                  onChange={e => setEmailSubject(e.target.value)} 
                  disabled={isBusy}
                  className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-blue-500 transition-[border-color,box-shadow,opacity] shadow-soft-sm disabled:opacity-50" 
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1.5">메일 본문</label>
                <textarea 
                  required 
                  rows={4}
                  value={emailMessage} 
                  onChange={e => setEmailMessage(e.target.value)} 
                  disabled={isBusy}
                  className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-blue-500 transition-[border-color,box-shadow,opacity] shadow-soft-sm disabled:opacity-50 resize-none" 
                />
              </div>
            </div>
          </div>
          
          <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex justify-between items-center gap-4">
            
            <input 
              type="file" 
              ref={fileInputRef} 
              accept=".xlsx, .xls"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) {
                  setMode('manual');
                  handleManualFileUpload(e);
                }
                e.target.value = '';
              }}
              disabled={isBusy}
            />

            <div className="flex items-center bg-slate-200/50 p-1 rounded-lg border border-slate-200/50 shrink-0">
              <button 
                type="button" 
                onClick={() => { setMode('auto'); setConvertedFile(null); setManualFile(null); setManualError(null); setStep('IDLE'); }} 
                className={`px-3 py-1.5 text-[11px] font-bold rounded-md transition-colors ${mode === 'auto' ? 'bg-white text-slate-800 shadow-soft-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                disabled={isBusy}
              >
                자동 연동
              </button>
              <button 
                type="button" 
                onClick={() => fileInputRef.current?.click()} 
                className={`px-3 py-1.5 text-[11px] font-bold rounded-md transition-colors ${mode === 'manual' ? 'bg-white text-slate-800 shadow-soft-sm border border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                disabled={isBusy}
              >
                수동 첨부
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button 
                type="button" 
                disabled={isBusy} 
                onClick={onClose} 
                className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-[background-color,opacity] disabled:opacity-50"
              >
                취소
              </button>
              <button 
                type="submit" 
                disabled={isBusy || (mode === 'manual' && !manualFile)} 
                className="px-5 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 font-bold shadow-soft-md transition-[background-color,opacity] flex items-center gap-2 disabled:opacity-50"
              >
                {isBusy ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>{step === 'ANALYZING' ? '분석/추출중...' : step === 'CONVERTING' ? '변환중...' : '발송중...'}</span>
                  </>
                ) : (
                  <span>발송</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
