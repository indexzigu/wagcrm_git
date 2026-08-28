import asyncio
import urllib.request
import ssl
from playwright.async_api import async_playwright

ssl._create_default_https_context = ssl._create_unverified_context

async def get_instagram_data(url):
    safe_url = url.replace('/reels/', '/p/')
    embed_url = safe_url.rstrip('/') + '/embed'
    print(f"\n[{embed_url}] 접속 중...")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        
        try:
            await page.goto(embed_url, wait_until="networkidle", timeout=30000)
            await asyncio.sleep(2)
            
            # 1. 썸네일 이미지
            img_src = await page.evaluate('''() => {
                const img = document.querySelector('img.EmbeddedMediaImage');
                return img ? img.src : null;
            }''')
            
            # 2. 비디오 소스 (릴스 동영상 추출 시도!)
            video_src = await page.evaluate('''() => {
                // video 태그 찾기
                const video = document.querySelector('video');
                if (video && video.src) return video.src;
                
                // source 태그를 쓰는 경우
                const source = document.querySelector('video source');
                if (source && source.src) return source.src;
                
                return null;
            }''')
            
            # 3. 계정명
            username = await page.evaluate('''() => {
                const links = Array.from(document.querySelectorAll('a'));
                const profileLink = links.find(a => a.innerText.trim().length > 0 && !a.innerText.includes('View profile') && !a.innerText.includes('Instagram'));
                return profileLink ? profileLink.innerText.trim() : null;
            }''')

            # 4. 프로필 이미지
            profile_pic = await page.evaluate('''() => {
                const img = Array.from(document.querySelectorAll('img')).find(i => !i.classList.contains('EmbeddedMediaImage'));
                return img ? img.src : null;
            }''')
            
            print(f"👤 계정명: {username if username else '추출 실패'}")
            print(f"🖼️ 프로필 이미지: {profile_pic[:100] + '...' if profile_pic else '추출 실패'}")
            
            if img_src:
                print("✅ 썸네일: 추출 성공!")
            else:
                print("❌ 썸네일: 실패")
                
            if video_src:
                # blob: 주소인지, 실제 mp4 cdn 주소인지 확인
                print(f"🎬 비디오 URL: {video_src[:100]}...")
                if video_src.startswith('http'):
                    print("🎉 실제 동영상 파일 추출 성공! (이 주소로 CRM에서 자동재생 가능)")
                else:
                    print("⚠️ 동영상이 Blob URL로 감춰져 있어 바로 재생하기 까다롭습니다.")
            else:
                print("❌ 비디오: 해당 게시물에 동영상이 없거나 태그를 찾지 못했습니다.")
            
        except Exception as e:
            print(f"❌ 에러 발생: {e}")
            
        finally:
            await browser.close()

if __name__ == "__main__":
    test_urls = [
        'https://www.instagram.com/reels/DTbqnQUE9Yd/' # 릴스 주소
    ]
    for u in test_urls:
        asyncio.run(get_instagram_data(u))
        print("-" * 50)
