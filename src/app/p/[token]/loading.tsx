// cacheComponents 셸 프리렌더 통과용 Suspense 경계 (sellers/[id] 패턴과 동일)
export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-sm text-slate-500 animate-pulse">리포트를 불러오는 중…</div>
    </div>
  );
}
