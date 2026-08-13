export const DELIVERY_LOCATION_MAX_AGE_MS = 30_000;
export const DELIVERY_LOCATION_FUTURE_TOLERANCE_MS = 5_000;
export const DELIVERY_LOCATION_MAX_ACCURACY_METERS = 100;
export const DELIVERY_LOCATION_MIN_UPDATE_INTERVAL_MS = 15_000;

export type DeliveryLocationProof = {
  latitude: string;
  longitude: string;
  accuracy: number;
  capturedAt: string;
  capturedAtMs: number;
};

export class DeliveryLocationProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryLocationProofError";
  }
}

function coordinate(value: unknown, minimum: number, maximum: number, label: string) {
  const text = String(value ?? "").trim();
  const number = Number(text);
  if (!text || !Number.isFinite(number) || number < minimum || number > maximum) {
    throw new DeliveryLocationProofError(`A valid ${label} is required from browser geolocation`);
  }
  return number.toFixed(6);
}

export function validateDeliveryLocationProof(
  input: Record<string, unknown>,
  nowMs = Date.now(),
): DeliveryLocationProof {
  const capturedAtInput = String(input.capturedAt ?? "").trim();
  const capturedAtMs = Date.parse(capturedAtInput);
  if (!capturedAtInput || !Number.isFinite(capturedAtMs)) {
    throw new DeliveryLocationProofError("A browser geolocation timestamp is required");
  }
  if (capturedAtMs < nowMs - DELIVERY_LOCATION_MAX_AGE_MS) {
    throw new DeliveryLocationProofError("The browser geolocation is stale. Capture a fresh position and retry");
  }
  if (capturedAtMs > nowMs + DELIVERY_LOCATION_FUTURE_TOLERANCE_MS) {
    throw new DeliveryLocationProofError("The browser geolocation timestamp is invalid");
  }
  const accuracy = Number(input.accuracy);
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > DELIVERY_LOCATION_MAX_ACCURACY_METERS) {
    throw new DeliveryLocationProofError(`Browser geolocation accuracy must be within ${DELIVERY_LOCATION_MAX_ACCURACY_METERS} metres`);
  }
  return {
    latitude: coordinate(input.latitude, -90, 90, "latitude"),
    longitude: coordinate(input.longitude, -180, 180, "longitude"),
    accuracy: Math.round(accuracy * 10) / 10,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
  };
}

export function deliveryTimestampMs(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
