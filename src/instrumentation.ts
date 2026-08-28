export async function register() {
  if (process.env.NODE_ENV === "development") {
    // Skip Sentry initialization in development to prevent Next.js 16/Sentry v10 compatibility crash
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = async (err: unknown, request: any, requestContext: any) => {
  if (process.env.NODE_ENV === "development") {
    console.error(err);
    return;
  }
  const Sentry = await import("@sentry/nextjs");
  return Sentry.captureRequestError(err, request, requestContext);
};
