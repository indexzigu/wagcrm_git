const SOCIAL_PREVIEW_USER_AGENT =
  /(?:kakaotalk|facebookexternalhit|twitterbot|slackbot|discordbot|linkedinbot|telegrambot|whatsapp|bot\b|crawler|spider)/i;

export function getSocialPreviewRewritePath(pathname: string, userAgent: string): string | null {
  if (!SOCIAL_PREVIEW_USER_AGENT.test(userAgent)) return null;

  const match = pathname.match(/^\/sellers\/([A-Za-z0-9_-]+)\/?$/);
  return match ? `/share/sellers/${match[1]}` : null;
}
