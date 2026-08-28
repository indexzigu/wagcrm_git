import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import https from 'https';

// .env.local 로드
const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // fallback
}

const token = process.env.INSTAGRAM_ACCESS_TOKEN;
const TEST_URL = 'https://www.instagram.com/p/C6_s-jGv2lJ/';

console.log('=== 인스타그램 무비용 썸네일 수집 테스트 ===\n');

// 1. 자체 스크래핑 테스트 (HTML 파싱)
async function testSelfScraping() {
  console.log('[1차 시도] 자체 HTML 스크래핑 테스트 중...');
  try {
    const res = await fetch(TEST_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      }
    });
    
    const html = await res.text();
    const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    
    if (res.url.includes('login') || html.includes('Login • Instagram')) {
      console.log('❌ 실패: 인스타그램이 로그인 화면으로 리다이렉트 시켰습니다 (봇 차단).');
    } else if (ogImageMatch) {
      console.log('✅ 성공: HTML에서 og:image 추출 성공!');
      console.log('추출된 URL:', ogImageMatch[1]);
    } else {
      console.log('❌ 실패: HTML은 가져왔으나 og:image 태그를 찾을 수 없습니다.');
    }
  } catch (err) {
    console.log('❌ 네트워크 에러:', err.message);
  }
  console.log('\n----------------------------------------\n');
}

// 2. 메타 공식 oEmbed API 테스트
async function testOembedApi() {
  console.log('[2차 시도] 메타 공식 oEmbed API 테스트 중...');
  if (!token) {
    console.log('❌ 실패: INSTAGRAM_ACCESS_TOKEN이 .env.local에 없습니다.');
    return;
  }
  
  const endpoint = `https://graph.facebook.com/v20.0/instagram_oembed?url=${encodeURIComponent(TEST_URL)}&access_token=${token}`;
  
  try {
    const res = await fetch(endpoint);
    const data = await res.json();
    
    if (res.ok && data.thumbnail_url) {
      console.log('✅ 성공: oEmbed API에서 썸네일 반환 완료!');
      console.log('추출된 URL:', data.thumbnail_url);
    } else {
      console.log('❌ 실패: oEmbed API 응답 거부 또는 데이터 없음.');
      console.log('에러 메시지:', data.error?.message || JSON.stringify(data));
      if (data.error?.message?.includes('oEmbed Read')) {
        console.log('💡 원인: 해당 페이스북 앱에 "oEmbed Read" 권한이 승인되지 않았습니다.');
      }
    }
  } catch (err) {
    console.log('❌ 네트워크 에러:', err.message);
  }
}

async function runAll() {
  await testSelfScraping();
  await testOembedApi();
}

runAll();
