/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runReservationRecovery } from "../lib/reservation-recovery.ts";
import { processDueReminders, reminderProcessingWindow } from "../lib/reminder-processing.ts";
import { REMINDER_PROCESSING_CRON, RESERVATION_RECOVERY_CRON, TRANSACTIONAL_EMAIL_OUTBOX_CRON, VENDOR_INVENTORY_ALERT_CRON } from "../lib/scheduled-job-config.ts";
import { generateVendorInventoryAlerts } from "../lib/vendor-inventory-alerts.ts";
import { processTransactionalEmailOutbox } from "../lib/transactional-email-outbox.ts";
import { withSecurityHeaders } from "../lib/security-headers.ts";

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
  INTEGRATION_TEST_AUTH_SECRET?: string;
  REMINDER_JOB_SECRET?: string;
  EINVOICE_API_URL?: string;
  EINVOICE_API_KEY?: string;
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

interface ScheduledController {
  cron: string;
  scheduledTime: number;
  noRetry(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    installRuntimeBindings(env);
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(request, response);
    }

    return withSecurityHeaders(request, await handler.fetch(request, env, ctx));
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    installRuntimeBindings(env);
    if (controller.cron === RESERVATION_RECOVERY_CRON) {
      ctx.waitUntil(runReservationRecovery({
        db: env.DB,
        scheduledAt: controller.scheduledTime,
      }).then((result) => {
        console.info("Scheduled inventory reservation recovery completed", {
          cron: controller.cron,
          runKey: result.runKey,
          batchesProcessed: result.batchesProcessed,
          ordersReleased: result.ordersReleased,
          reservationsReleased: result.reservationsReleased,
          remainingExpiredOrders: result.remainingExpiredOrders,
          duplicate: result.duplicate,
        });
      }).catch((error) => {
        console.error("Scheduled inventory reservation recovery failed", error);
        throw error;
      }));
      return;
    }
    if (controller.cron === REMINDER_PROCESSING_CRON) {
      ctx.waitUntil(processDueReminders({
        db: env.DB,
        now: controller.scheduledTime,
        requestId: `cloudflare-scheduled:${controller.scheduledTime}`,
      }).then((result) => {
        console.info("Scheduled customer reminder processing completed", {
          cron: controller.cron,
          window: result.window,
          processed: result.processed,
          email: result.email,
        });
      }).catch((error) => {
        console.error("Scheduled customer reminder processing failed", error);
        throw error;
      }));
      return;
    }
    if (controller.cron === VENDOR_INVENTORY_ALERT_CRON) {
      const processingDate = reminderProcessingWindow(controller.scheduledTime).localDate;
      ctx.waitUntil(generateVendorInventoryAlerts({
        db: env.DB,
        processingDate,
      }).then((result) => {
        console.info("Scheduled vendor inventory alert processing completed", {
          cron: controller.cron,
          processingDate: result.processingDate,
          generated: result.generated,
        });
      }).catch((error) => {
        console.error("Scheduled vendor inventory alert processing failed", error);
        throw error;
      }));
      return;
    }
    if (controller.cron === TRANSACTIONAL_EMAIL_OUTBOX_CRON) {
      ctx.waitUntil(processTransactionalEmailOutbox({
        db: env.DB,
        leaseOwner: `worker:${controller.scheduledTime}`,
        now: controller.scheduledTime,
      }).then((result) => {
        console.info("Scheduled transactional email outbox processing completed", {
          cron: controller.cron,
          policyVersion: result.policyVersion,
          claimed: result.claimed,
          sent: result.sent,
          retryWaiting: result.retryWaiting,
          deadLettered: result.deadLettered,
          cancelled: result.cancelled,
          remainingDue: result.remainingDue,
        });
      }).catch((error) => {
        console.error("Scheduled transactional email outbox processing failed", error);
        throw error;
      }));
      return;
    }
    console.warn("Ignored unknown scheduled event", { cron: controller.cron });
  },
};

function installRuntimeBindings(env: Env) {
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
    INTEGRATION_TEST_AUTH_SECRET: env.INTEGRATION_TEST_AUTH_SECRET,
    REMINDER_JOB_SECRET: env.REMINDER_JOB_SECRET,
    EINVOICE_API_URL: env.EINVOICE_API_URL,
    EINVOICE_API_KEY: env.EINVOICE_API_KEY,
  };
}

export default worker;
