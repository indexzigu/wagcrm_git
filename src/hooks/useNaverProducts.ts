import { useState, useCallback } from 'react';

export function useNaverProducts() {
  const [naverProducts, setNaverProducts] = useState<any[]>([]);
  const [isFetchingNaver, setIsFetchingNaver] = useState(false);

  const fetchNaverProducts = useCallback(async () => {
    try {
      setIsFetchingNaver(true);
      const res = await fetch('/order-converter/api/naver/products');
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setNaverProducts(data.products || []);
          return { success: true, products: data.products };
        } else {
          return { success: false, error: data.error };
        }
      }
      return { success: false, error: '서버 응답 오류' };
    } catch (e) {
      console.error(e);
      return { success: false, error: '상품 조회 중 오류가 발생했습니다.' };
    } finally {
      setIsFetchingNaver(false);
    }
  }, []);

  return {
    naverProducts,
    isFetchingNaver,
    fetchNaverProducts,
  };
}
