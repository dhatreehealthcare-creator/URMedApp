import { getRequiredRuntimeValue } from "./runtime-env.ts";

const RAZORPAY_API = "https://api.razorpay.com/v1";

type RazorpayErrorBody = {
  error?: { description?: string };
};

export type RazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
};

export type RazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: "pending" | "processed" | "failed";
};

export class RazorpayProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "RazorpayProviderError";
    this.status = status;
  }
}

function authorizationHeader() {
  const keyId = getRequiredRuntimeValue("RAZORPAY_KEY_ID");
  const keySecret = getRequiredRuntimeValue("RAZORPAY_KEY_SECRET");
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  let payload: (T & RazorpayErrorBody) | null = null;
  try {
    payload = await response.json() as T & RazorpayErrorBody;
  } catch {
    throw new RazorpayProviderError(fallback);
  }
  if (!response.ok) {
    throw new RazorpayProviderError(payload.error?.description?.trim() || fallback);
  }
  return payload;
}

export async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPayment> {
  const response = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authorizationHeader() },
  });
  const payload = await parseResponse<Partial<RazorpayPayment>>(response, "Razorpay could not verify the payment");
  if (!payload.id || !payload.order_id || !Number.isInteger(payload.amount) || !payload.currency || !payload.status) {
    throw new RazorpayProviderError("Razorpay returned an incomplete payment record");
  }
  return payload as RazorpayPayment;
}

export async function createRazorpayRefund(input: {
  paymentId: string;
  amountPaise: number;
  receipt: string;
  orderId: number;
  reason: string;
}): Promise<RazorpayRefund> {
  const response = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(input.paymentId)}/refund`, {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(),
      "Content-Type": "application/json",
      "X-Refund-Idempotency": input.receipt,
    },
    body: JSON.stringify({
      amount: input.amountPaise,
      speed: "normal",
      receipt: input.receipt,
      notes: { urmed_order_id: String(input.orderId), reason: input.reason.slice(0, 200) },
    }),
  });
  const payload = await parseResponse<Partial<RazorpayRefund>>(response, "Razorpay could not initiate the refund");
  if (!payload.id || payload.payment_id !== input.paymentId || payload.amount !== input.amountPaise
    || payload.currency !== "INR" || payload.receipt !== input.receipt
    || !["pending", "processed", "failed"].includes(payload.status ?? "")) {
    throw new RazorpayProviderError("Razorpay returned an inconsistent refund record");
  }
  return payload as RazorpayRefund;
}
