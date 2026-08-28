import { getApifyToken } from './apify';
import { LosslessSellerData, RawPost, normalizeMediaType, toIsoTimestamp } from './types'; // 데이터 형상 타입·헬퍼
import { isGraphConfigured, scrapeTier0 } from './graphScraper';
import { fetchCommentsByShortcode, pickCommentTargets } from './apifyComments';
import { recordApifyCommentUsage } from './apify-comment-usage';
import { applyDbInstagramToken } from '@/lib/instagram-token';
import { rapidApiFetch } from '@/lib/rapidapi-keys';

// export const APIFY_TOKEN = process.env.APIFY_API_TOKEN; (Removed)
// 키 선택·로테이션은 `@/lib/rapidapi-keys` 로 이관했다(2026-07-23). 기존 구현은 모듈 전역
// 라운드로빈이라 서버리스에서 매 인스턴스가 첫 키만 태웠고, 429 감지도 없었다.

// Tier 1: Apify (Official apify~instagram-post-scraper) + RapidAPI (for profile info)
async function scrapeTier1(handle: string): Promise<LosslessSellerData> {
  const ACTOR_ID = "apify~instagram-post-scraper";
  console.log(`[Tier 1] Starting Apify (${ACTOR_ID}) for ${handle}...`);
  
  const currentToken = getApifyToken();
  if (!currentToken) throw new Error("APIFY_API_TOKEN is missing.");

  // 동기 방식 호출 (대기 없음, 즉각 반환)
  const syncResPromise = fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${currentToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "username": [handle],
      "resultsLimit": 30, // Apify 결과수 비례 과금 — 50→30 축소(2026-07-06 사용자 결정, 지표 표본으로 충분)
      "includeComments": true,
      "commentsSortOrder": "popular",
      "commentsLimit": 100
    })
  });

  // Apify Post API는 팔로워 수, bio를 제공하지 않으므로 RapidAPI에서 동시 호출하여 보강
  const profileResPromise = rapidApiFetch(`https://instagram-scraper-20251.p.rapidapi.com/userinfo/?username_or_id=${handle}`)
    .catch(() => null);

  const [syncRes, profileRes] = await Promise.all([syncResPromise, profileResPromise]);

  if (!syncRes.ok) throw new Error(`Apify Run failed: ${await syncRes.text()}`);
  
  const items = await syncRes.json();
  if (!items || items.length === 0) throw new Error("No data returned from Apify.");

  let profileData: any = {};
  if (profileRes && profileRes.ok) {
    const profileRaw = await profileRes.json();
    profileData = Array.isArray(profileRaw) ? profileRaw.find(x => x && x.username) || profileRaw[0] : (profileRaw?.data || profileRaw);
  }

  // 데이터 가공 (대표님이 제공하신 Output 스키마 준수)
  // 응답 배열의 첫 번째 아이템에서 프로필(author) 정보를 뽑음
  const firstItem = items[0];
  const author = firstItem.author || {};
  
  const raw_posts: RawPost[] = items.map((item: any) => {
    // comments 추출
    const commentsList = (item.comments || []).map((c: any) => c.text);
    // 대체용 최신 코멘트(latestComments)도 확인
    const latestCommentsList = (item.latestComments || []).map((c: any) => c.text);

    const videoViewCandidate = item.videoViewCount ?? item.engagement?.video_view_count ?? item.videoPlayCount;

    return {
      caption: item.caption?.text || item.caption || "",
      likes: item.engagement?.like_count || item.likesCount || 0,
      comments_count: item.engagement?.comment_count || item.commentsCount || 0,
      sample_comments: commentsList.length > 0 ? commentsList : latestCommentsList,
      taken_at: toIsoTimestamp(item.timestamp ?? item.taken_at),
      media_type: normalizeMediaType(item.type ?? item.media?.type, item.productType),
      video_view_count: typeof videoViewCandidate === 'number' ? videoViewCandidate : null,
      is_sponsored: item.isSponsored === true || item.paidPartnership === true,
      video_url: item.videoUrl || item.video_url || null,
      thumbnail_url: item.media?.display_uri || item.displayUrl || item.images?.[0] || null,
      shortcode: item.shortCode || item.code || null,
    };
  });

  const images = items
    .map((item: any) => item.media?.display_uri || item.displayUrl || item.images?.[0])
    .filter(Boolean)
    .slice(0, 10);

  // 프로필 사진은 images[0](Gemini 첨부용)과 profile.profilePicUrl(analyze의 Seller 동기화용) 이중 소비
  const profilePicUrl = profileData?.hd_profile_pic_url_info?.url || profileData?.profile_pic_url || author.hd_profile_pic_url || author.profile_pic_url || null;
  if (profilePicUrl) images.unshift(profilePicUrl);

  return {
    seller_id: handle,
    source_tier: "Tier 1 (Apify + RapidAPI Profile)",
    debug_info: `Apify Fetched: ${items.length} posts. RapidAPI Profile Fetched: ${!!(profileData && profileData.username)}`,
    profile: {
      username: profileData?.username || author.username || handle,
      fullName: profileData?.full_name || author.full_name || "",
      bio: profileData?.biography || "",
      follower_count: profileData?.follower_count || 0,
      following_count: profileData?.following_count || 0,
      profilePicUrl,
    },
    raw_posts,
    images
  };
}

// Tier 2: RapidAPI (instagram-scraper-20251)
async function scrapeTier2(handle: string): Promise<LosslessSellerData> {
  console.log(`[Tier 2] Starting RapidAPI for ${handle}...`);
  
  // 1. 프로필 정보 획득
  const profileRes = await rapidApiFetch(`https://instagram-scraper-20251.p.rapidapi.com/userinfo/?username_or_id=${handle}`);
  if (!profileRes.ok) throw new Error(`RapidAPI /userinfo failed: ${profileRes.status}`);
  const profileRaw = await profileRes.json();
  // RapidAPI /userinfo 응답은 배열 형태로 첫번째 요소 반환 (이전 분석 결과)
  const profileData = Array.isArray(profileRaw) ? profileRaw.find(x => x && x.username) || profileRaw[0] : (profileRaw?.data || profileRaw);
  if (!profileData || !profileData.username) throw new Error("RapidAPI returned malformed profile data.");

  // 2. 포스트 정보 획득
  const postsRes = await rapidApiFetch(`https://instagram-scraper-20251.p.rapidapi.com/userposts/?username_or_id=${handle}`);
  if (!postsRes.ok) throw new Error(`RapidAPI /userposts failed: ${postsRes.status}`);
  const postsRaw = await postsRes.json();
  
  const postsData = postsRaw?.data?.items || [];

  const raw_posts: RawPost[] = postsData.map((item: any) => {
    const videoViewCandidate = item.play_count ?? item.view_count;
    return {
      caption: item.caption?.text || "",
      likes: item.like_count || 0,
      comments_count: item.comment_count || 0,
      sample_comments: [], // RapidAPI 기본 posts 응답에는 딥 코멘트가 없음 (별도 코멘트 호출 필요)
      taken_at: toIsoTimestamp(item.taken_at), // unix 초 → ISO
      media_type: normalizeMediaType(item.media_type, item.product_type), // 1=image, 2=video, 8=carousel, clips=reel
      video_view_count: typeof videoViewCandidate === 'number' ? videoViewCandidate : null,
      is_sponsored: item.is_paid_partnership === true,
      video_url: item.video_versions?.[0]?.url || null,
      thumbnail_url:
        item.image_versions2?.candidates?.[0]?.url ||
        item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
        null,
      shortcode: item.code || null,
    };
  });

  const images = postsData
    .map((item: any) => item.image_versions2?.candidates?.[0]?.url || item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url)
    .filter(Boolean)
    .slice(0, 10);

  // 프로필 사진은 images[0](Gemini 첨부용)과 profile.profilePicUrl(analyze의 Seller 동기화용) 이중 소비
  const profilePicUrl = profileData.hd_profile_pic_url_info?.url || profileData.profile_pic_url || null;
  if (profilePicUrl) images.unshift(profilePicUrl);

  return {
    seller_id: handle,
    source_tier: "Tier 2 (RapidAPI Only)",
    debug_info: `RapidAPI posts fetched: ${postsData.length}`,
    profile: {
      username: profileData.username || handle,
      fullName: profileData.full_name || "",
      bio: profileData.biography || "",
      follower_count: profileData.follower_count || 0,
      following_count: profileData.following_count || 0,
      profilePicUrl,
    },
    raw_posts,
    images
  };
}

// Tier 0 댓글 보강: Graph BD는 댓글 텍스트를 안 주므로 Apify comment-scraper로 공구글 우선 타깃만 주입.
// 댓글은 보강 신호(오디언스 품질·구매의도)라 실패해도 분석은 진행한다 — 단 실패를 삼키지 않고
// debug_info·콘솔에 더해 **ApiCallLog 1행**으로 영속한다(P0 No Silent Failure + 지출 관측).
// Gemini 페이로드가 최신 30개만 소비하므로 타깃도 같은 창에서 골라 지출과 분석 대상을 일치시킨다.
//
// 기록 범위: **실제 호출이 나간 경우만** 1행을 남긴다. 아래 두 skip 은 호출도 지출도 없으므로
// 기록하지 않는다 — 넣으면 "월 호출 횟수"가 부풀어 지표 자체가 못 쓰게 된다.
// (댓글 없이 끝난 Tier0 는 `source_tier` 가 'Tier 0 (Graph API)' 로 남아 이미 구분된다.)
async function enrichTier0Comments(data: LosslessSellerData): Promise<void> {
  if (!getApifyToken()) {
    data.debug_info += ' Comments skipped: APIFY_API_TOKEN 미설정.';
    return;
  }
  const targets = pickCommentTargets(data.raw_posts.slice(0, 30));
  if (targets.length === 0) {
    data.debug_info += ' Comments skipped: no eligible posts.';
    return;
  }
  try {
    const { byShortcode, usage } = await fetchCommentsByShortcode(
      targets.map((t) => t.shortcode as string)
    );

    let filled = 0;
    for (const post of data.raw_posts) {
      const comments = post.shortcode ? byShortcode.get(post.shortcode) : undefined;
      if (comments && comments.length > 0) {
        post.sample_comments = comments;
        filled++;
      }
    }

    // 성공·실패 양쪽 모두 기록한다 — 실패는 조용히 묻히기 쉬운 쪽이라 오히려 더 중요하다.
    await recordApifyCommentUsage({ ...usage, filledPosts: filled });

    if (usage.ok) {
      data.source_tier = 'Tier 0 (Graph API + Apify Comments)';
      data.debug_info +=
        ` Apify comments filled: ${filled}/${targets.length} posts` +
        ` (${usage.receivedComments} comments, ${usage.durationMs}ms).`;
    } else {
      console.warn(`[Tier 0] 댓글 보조 수집 실패(분석은 진행): ${usage.errorMessage}`);
      data.debug_info += ` Apify comments failed: ${usage.errorMessage}`;
    }
  } catch (error: any) {
    // 안전망: 여기서 throw 가 새면 성공한 Tier0(무료)가 Tier1(유료 폴백)로 강등된다.
    const msg = error?.message || String(error);
    console.warn(`[Tier 0] 댓글 보조 수집 실패(분석은 진행): ${msg}`);
    data.debug_info += ` Apify comments failed: ${msg}`;
  }
}

// Waterfall Orchestrator — Tier0(Graph 공식 API, 무료) → Tier1(Apify posts) → Tier2(RapidAPI).
// 개인계정은 Tier0의 business_discovery 에러로 떨어져 자동으로 Tier1 폴백된다.
// 전 티어 실패 시 원인을 전부 합쳐 throw한다. 빈 데이터를 성공처럼 반환하는 폴백 경로는
// 두지 않는다 (P0 No Silent Failure).
export async function scrapeSellerDataWaterfall(usernameOrUrl: string): Promise<LosslessSellerData> {
  let handle = usernameOrUrl;
  try {
    const urlObj = new URL(usernameOrUrl);
    const pathSegments = urlObj.pathname.split('/').filter(Boolean);
    if (pathSegments.length > 0) handle = pathSegments[0];
  } catch {
    // URL이 아닌 경우 그대로 사용
  }
  handle = handle.replace(/^@+/, '').trim();

  const failures: string[] = [];

  // F5: DB에 갱신된 토큰이 있으면 env를 덮어써 Tier0(graphScraper의 env 직독)가 최신 토큰 사용
  await applyDbInstagramToken();

  // Tier 0 시도 (env 미설정이면 조용히 건너뛰지 않고 실패 사유에 기록)
  if (isGraphConfigured()) {
    try {
      const data = await scrapeTier0(handle);
      await enrichTier0Comments(data);
      return data;
    } catch (error: any) {
      const msg = error?.message || String(error);
      failures.push(`Tier0: ${msg}`);
      console.error(`[Scraper] Tier 0 failed: ${msg}`);
    }
  } else {
    failures.push('Tier0: skipped (INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_BUSINESS_ACCOUNT_ID 미설정)');
  }

  // Tier 1 시도
  try {
    return await scrapeTier1(handle);
  } catch (error: any) {
    const msg = error?.message || String(error);
    failures.push(`Tier1: ${msg}`);
    console.error(`[Scraper] Tier 1 failed: ${msg}`);
  }

  // Tier 2 시도
  try {
    return await scrapeTier2(handle);
  } catch (error: any) {
    const msg = error?.message || String(error);
    failures.push(`Tier2: ${msg}`);
    console.error(`[Scraper] Tier 2 failed: ${msg}`);
  }

  throw new Error(failures.join(' / '));
}
