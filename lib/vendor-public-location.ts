import { isValidGeoPoint } from "./geo.ts";

export type VendorPublicLocationInput = {
  label: string;
  address: string;
  latitude: string;
  longitude: string;
  pickupEnabled: boolean;
  serviceEnabled: boolean;
  serviceRadiusKm: number;
};

export type PublishedVendorLocation = VendorPublicLocationInput;

const publicLocationColumnNames = [
  "publicLocationLabel",
  "publicLocationAddress",
  "publicLocationLatitude",
  "publicLocationLongitude",
  "publicPickupEnabled",
  "publicServiceEnabled",
  "publicServiceRadiusKm",
] as const;

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

function enabled(value: unknown) {
  return value === true || value === 1 || value === "1";
}

export class VendorPublicLocationValidationError extends Error {}

export function validateVendorPublicLocation(input: Record<string, unknown>): VendorPublicLocationInput {
  const label = text(input.label, 80);
  const address = text(input.address, 500);
  const latitudeValue = Number(input.latitude);
  const longitudeValue = Number(input.longitude);
  const pickupEnabled = enabled(input.pickupEnabled);
  const serviceEnabled = enabled(input.serviceEnabled);
  const serviceRadiusKm = Number(input.serviceRadiusKm);

  if (!label) throw new VendorPublicLocationValidationError("Enter a public location label");
  if (!address) throw new VendorPublicLocationValidationError("Enter the customer-facing pickup or service address");
  if (!isValidGeoPoint({ latitude: latitudeValue, longitude: longitudeValue })) {
    throw new VendorPublicLocationValidationError("Select a valid customer-facing map location");
  }
  if (!pickupEnabled && !serviceEnabled) {
    throw new VendorPublicLocationValidationError("Enable pickup, public service-distance search, or both");
  }
  if (!Number.isInteger(serviceRadiusKm) || serviceRadiusKm < 1 || serviceRadiusKm > 50) {
    throw new VendorPublicLocationValidationError("Service radius must be a whole number from 1 to 50 km");
  }

  return {
    label,
    address,
    latitude: latitudeValue.toFixed(6),
    longitude: longitudeValue.toFixed(6),
    pickupEnabled,
    serviceEnabled,
    serviceRadiusKm,
  };
}

export function attachPublishedVendorLocation(record: Record<string, unknown>): Record<string, unknown> & {
  publicLocation: PublishedVendorLocation | null;
} {
  const output = { ...record };
  for (const key of publicLocationColumnNames) delete output[key];

  const label = String(record.publicLocationLabel ?? "").trim();
  const address = String(record.publicLocationAddress ?? "").trim();
  const latitude = String(record.publicLocationLatitude ?? "").trim();
  const longitude = String(record.publicLocationLongitude ?? "").trim();
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!label || !address || !latitude || !longitude || !isValidGeoPoint(point)) {
    return { ...output, publicLocation: null };
  }

  return {
    ...output,
    publicLocation: {
      label,
      address,
      latitude,
      longitude,
      pickupEnabled: Boolean(record.publicPickupEnabled),
      serviceEnabled: Boolean(record.publicServiceEnabled),
      serviceRadiusKm: Number(record.publicServiceRadiusKm),
    },
  };
}
