import { requireIsoDate } from "./date-controls.ts";
import { isValidGeoPoint } from "./geo.ts";

export const VENDOR_LICENCE_FORMS = ["20", "21", "20B", "21B", "20F", "21F"] as const;

const licenceForms = new Set<string>(VENDOR_LICENCE_FORMS);
const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export type VendorRegistrationDetails = {
  businessName: string;
  ownerName: string;
  phone: string;
  landline: string;
  gstNumber: string;
  address: string;
  latitude: string;
  longitude: string;
  homeDelivery: boolean;
  deliveryRadiusKm: number;
  licenceNumber: string;
  formType: string;
  issuingAuthority: string;
  issuedOn: string | null;
  validFrom: string;
  validUntil: string;
  documentId: number;
};

export class VendorRegistrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorRegistrationValidationError";
  }
}

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

function date(value: unknown, label: string, required = true) {
  try {
    return requireIsoDate(value, label, !required);
  } catch (error) {
    throw new VendorRegistrationValidationError(error instanceof Error ? error.message : `${label} is invalid`);
  }
}

export function validateVendorRegistration(input: Record<string, unknown>): VendorRegistrationDetails {
  const businessName = text(input.businessName, 180);
  const ownerName = text(input.ownerName, 120);
  const phone = text(input.phone, 24).replace(/\D/g, "");
  const landline = text(input.landline, 24).replace(/\D/g, "");
  const gstNumber = text(input.gstNumber, 15).toUpperCase();
  const address = text(input.address, 500);
  const latitude = text(input.latitude, 24);
  const longitude = text(input.longitude, 24);
  const licenceNumber = text(input.licenceNumber, 80).toUpperCase();
  const formType = text(input.formType, 8).toUpperCase();
  const issuingAuthority = text(input.issuingAuthority, 180);
  const documentId = Number(input.documentId);
  const deliveryRadiusKm = Math.max(1, Math.min(Number(input.deliveryRadiusKm) || 5, 50));
  const homeDelivery = input.homeDelivery === true || input.homeDelivery === 1 || input.homeDelivery === "1";

  if (!businessName || !ownerName) throw new VendorRegistrationValidationError("Shop or business name and owner name are required");
  if (!/^\d{10}$/.test(phone)) throw new VendorRegistrationValidationError("Phone must contain exactly 10 digits");
  if (landline && !/^\d{10}$/.test(landline)) throw new VendorRegistrationValidationError("Landline must contain exactly 10 digits when entered");
  if (gstNumber && !gstPattern.test(gstNumber)) throw new VendorRegistrationValidationError("GSTIN format is invalid");
  if (!address) throw new VendorRegistrationValidationError("The private registered address is required");
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!latitude || !longitude || !isValidGeoPoint(point)) throw new VendorRegistrationValidationError("Select a valid private pharmacy location");
  if (!licenceNumber || !licenceForms.has(formType) || !issuingAuthority) {
    throw new VendorRegistrationValidationError("Licence number, approved form type and issuing authority are required");
  }
  const validFrom = date(input.validFrom, "Licence valid-from date")!;
  const validUntil = date(input.validUntil, "Licence valid-until date")!;
  const issuedOn = date(input.issuedOn, "Licence issue date", false);
  if (validUntil < validFrom) throw new VendorRegistrationValidationError("Licence expiry must be after the valid-from date");
  if (!Number.isInteger(documentId) || documentId < 1) throw new VendorRegistrationValidationError("Upload the drug licence document first");

  return {
    businessName, ownerName, phone, landline, gstNumber, address, latitude, longitude,
    homeDelivery, deliveryRadiusKm,
    licenceNumber, formType, issuingAuthority, issuedOn, validFrom, validUntil, documentId,
  };
}
