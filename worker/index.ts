/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  DATA_ENCRYPTION_KEY?: string;
  APP_STAGE?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    (globalThis as typeof globalThis & { __URMED_D1__?: D1Database }).__URMED_D1__ = env.DB;
    (globalThis as typeof globalThis & { __URMED_R2__?: R2Bucket }).__URMED_R2__ = env.BUCKET;
    (globalThis as typeof globalThis & { __URMED_RUNTIME__?: Record<string, string | undefined> }).__URMED_RUNTIME__ = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
      RESEND_API_KEY: env.RESEND_API_KEY,
      RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
      RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
      DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY,
      APP_STAGE: env.APP_STAGE,
    };
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
