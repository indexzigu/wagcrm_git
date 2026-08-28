import { gotScraping } from 'got-scraping';

const TEST_URL = 'https://www.instagram.com/p/C6_s-jGv2lJ/';

async function testGotScraping() {
  console.log('=== got-scraping (스텔스 모듈) 테스트 ===');
  console.log('목표: 실제 크롬 브라우저의 TLS/JA3 지문을 완벽히 위장하여 인스타그램 접속\n');
  
  try {
    const { body, statusCode } = await gotScraping({
      url: TEST_URL,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        devices: ['desktop'],
        operatingSystems: ['windows', 'macos']
      }
    });

    console.log('Status:', statusCode);
    const ogImageMatch = body.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    
    if (body.includes('Login • Instagram') || body.includes('/accounts/login/')) {
      console.log('❌ 실패: TLS를 위장했음에도 인스타그램이 로그인 화면으로 리다이렉트 시켰습니다.');
      console.log('💡 결론: 인스타그램은 이제 지문 위장뿐 아니라, 접속 IP가 데이터센터(AWS/Vercel 등)인지 주택용(Residential)인지까지 실시간 검증합니다.');
    } else if (ogImageMatch) {
      console.log('✅ 성공: 썸네일 추출 완료!');
      console.log('URL:', ogImageMatch[1]);
    } else {
      console.log('❌ 실패: 로그인 창은 아니나 og:image가 없습니다.');
    }
  } catch (err) {
    console.log('❌ 에러:', err.message);
  }
}

testGotScraping();
