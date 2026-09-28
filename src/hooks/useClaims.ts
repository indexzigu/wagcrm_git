import { useState, useCallback, useEffect } from 'react';
import type { MaskedDerivedClaim } from '@/lib/order-converter/claim-derive';

// useCampaigns.ts:23 fetchCampaigns의 plain fetch 패턴을 그대로 복제한다.
// (SWR/react-query 등 별도 라이브러리 없이 useState+fetch로 유지하는 관례)

// 서버는 연락처를 뒷 4자리로만 내려준다(maskClaimForClient).
export type ClaimWithCompanyName = MaskedDerivedClaim & {
  collectDeliveryCompanyName: string | null;
};

export function useClaims() {
  const [claims, setClaims] = useState<ClaimWithCompanyName[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchClaims = useCallback(async (silent: boolean = false) => {
    try {
      if (!silent) setIsLoading(true);
      const res = await fetch(`/order-converter/api/naver/claims?t=${new Date().getTime()}`, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setClaims(Array.isArray(json?.data) ? json.data : []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClaims();
  }, [fetchClaims]);

  return {
    claims,
    isLoading,
    fetchClaims,
  };
}
