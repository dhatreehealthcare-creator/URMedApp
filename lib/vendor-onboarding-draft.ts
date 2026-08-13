import { isValidGeoPoint } from "./geo.ts";

const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

export class VendorOnboardingDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorOnboardingDraftError";
  }
}

export function validateVendorOnboardingDraft(input: Record<string, unknown>) {
  const businessName = text(input.businessName, 180);
  const ownerName = text(input.ownerName, 120);
  const landline = text(input.landline, 10).replace(/\D/g, "");
  const gstNumber = text(input.gstNumber, 15).toUpperCase();
  const address = text(input.address, 500);
  const latitude = text(input.latitude, 24);
  const longitude = text(input.longitude, 24);
  const licenceNumber = text(input.licenceNumber, 80).toUpperCase();
  const deliveryRadiusKm = Math.max(1, Math.min(Number(input.deliveryRadiusKm) || 5, 50));

  if (!businessName || !ownerName) throw new VendorOnboardingDraftError("Shop or business name and owner name are required before saving the draft");
  if (landline && !/^\d{10}$/.test(landline)) throw new VendorOnboardingDraftError("Landline must contain exactly 10 digits when entered");
  if (gstNumber && !gstPattern.test(gstNumber)) throw new VendorOnboardingDraftError("GSTIN format is invalid");
  if (address || latitude || longitude) {
    if (!address) throw new VendorOnboardingDraftError("The private registered address is required with saved coordinates");
    if (!isValidGeoPoint({ latitude: Number(latitude), longitude: Number(longitude) })) {
      throw new VendorOnboardingDraftError("Select a valid private pharmacy location before saving this step");
    }
  }

  return {
    businessName,
    ownerName,
    landline,
    gstNumber,
    address,
    latitude,
    longitude,
    homeDelivery: input.homeDelivery === true || input.homeDelivery === 1 || input.homeDelivery === "1",
    deliveryRadiusKm,
    licenceNumber,
  };
}
