import { fetch as undiciFetch, ProxyAgent } from 'undici';



export async function proxyFetch(url: string, options: any = {}) {
  const proxyUrlsStr = process.env.PROXY_URLS || process.env.FIXIE_URLS || process.env.FIXIE_URL;
  if (!proxyUrlsStr) {
    return undiciFetch(url, options);
  }
  
  const urls = proxyUrlsStr.split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    return undiciFetch(url, options);
  }

  // 첫 번째 URL을 메인(Primary)으로, 이후 URL들을 서브(Fallback)로 사용합니다.
  for (let i = 0; i < urls.length; i++) {
    const proxyUrl = urls[i];
    try {
      options.dispatcher = new ProxyAgent(proxyUrl);
      const res = await undiciFetch(url, options);
      
      // 403(IP 차단), 429(할당량 초과), 50x(서버 에러) 발생 시 다음 프록시(서브)로 폴백
      if (!res.ok && (res.status === 403 || res.status === 429 || res.status >= 500)) {
         if (i < urls.length - 1) {
             console.warn(`Proxy [${i}] returned ${res.status}. Falling back to next proxy...`);
             continue; // 다음 프록시 시도
         }
      }
      return res;
    } catch (err: any) {
      if (i === urls.length - 1) {
        throw err; // 마지막 프록시까지 실패하면 에러 반환
      }
      console.warn(`Proxy [${i}] fetch failed: ${err.message}. Retrying with next proxy...`);
    }
  }
  
  throw new Error("All proxies failed");
}
