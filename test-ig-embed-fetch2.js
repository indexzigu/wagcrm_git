const url = 'https://www.instagram.com/p/C6_s-jGv2lJ/embed';
fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
}).then(res => res.text()).then(html => {
  const thumbnailMatch = html.match(/class="EmbeddedMediaImage"[^>]+src="([^"]+)"/);
  const captionMatch = html.match(/"caption":"([^"]+)"/);
  console.log('HTML Length:', html.length);
  console.log('Thumbnail:', thumbnailMatch ? thumbnailMatch[1].replace(/&amp;/g, '&') : null);
  console.log('Caption:', captionMatch ? captionMatch[1] : null);
}).catch(console.error);
