export type BranchInput = {
  branchCode: string;
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  pickupEnabled: boolean;
  serviceEnabled: boolean;
  serviceRadiusKm: number;
  publicLabel?: string;
  publicAddress?: string;
  publicLatitude?: string;
  publicLongitude?: string;
  publishPublicLocation?: boolean;
};

export class BranchValidationError extends Error {}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function coordinate(value: unknown, label: string, required: boolean) {
  const text = clean(value, 32);
  if (!text && !required) return "";
  const number = Number(text);
  if (!Number.isFinite(number)) {
    throw new BranchValidationError(`${label} is invalid`);
  }
  if (label.toLowerCase().includes("latitude") && (number < -90 || number > 90)) throw new BranchValidationError("latitude is invalid");
  if (label.toLowerCase().includes("longitude") && (number < -180 || number > 180)) throw new BranchValidationError("longitude is invalid");
  return number.toFixed(6);
}

export function validateBranchInput(body: Record<string, unknown>): BranchInput {
  const branchCode = clean(body.branchCode, 32).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const name = clean(body.name, 160);
  const address = clean(body.address, 500);
  const latitude = coordinate(body.latitude, "latitude", false);
  const longitude = coordinate(body.longitude, "longitude", false);
  const pickupEnabled = bool(body.pickupEnabled);
  const serviceEnabled = bool(body.serviceEnabled);
  const serviceRadiusKm = Number(body.serviceRadiusKm ?? 5);
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(branchCode)) throw new BranchValidationError("Branch code must be 2-32 letters, numbers, _ or -");
  if (!name) throw new BranchValidationError("Branch name is required");
  if (!address) throw new BranchValidationError("Branch address is required");
  if ((latitude && !longitude) || (!latitude && longitude)) throw new BranchValidationError("Provide both branch coordinates or neither");
  if (!Number.isInteger(serviceRadiusKm) || serviceRadiusKm < 1 || serviceRadiusKm > 50) throw new BranchValidationError("Service radius must be a whole number from 1 to 50 km");
  if (!pickupEnabled && !serviceEnabled) throw new BranchValidationError("Enable pickup or delivery for this branch");
  const publishPublicLocation = body.publishPublicLocation === true;
  const publicLabel = clean(body.publicLabel, 80);
  const publicAddress = clean(body.publicAddress, 500);
  const publicLatitude = coordinate(body.publicLatitude, "public latitude", false);
  const publicLongitude = coordinate(body.publicLongitude, "public longitude", false);
  if (publishPublicLocation && (!publicLabel || !publicAddress || !publicLatitude || !publicLongitude)) {
    throw new BranchValidationError("A published branch requires an explicit customer-facing label, address and map point");
  }
  return { branchCode, name, address, latitude, longitude, pickupEnabled, serviceEnabled, serviceRadiusKm,
    publicLabel, publicAddress, publicLatitude, publicLongitude, publishPublicLocation };
}

export function publicBranchColumns(alias = "b") {
  return `${alias}.public_label AS publicLocationLabel, ${alias}.public_address AS publicLocationAddress,
    ${alias}.public_latitude AS publicLocationLatitude, ${alias}.public_longitude AS publicLocationLongitude,
    ${alias}.pickup_enabled AS publicPickupEnabled, ${alias}.service_enabled AS publicServiceEnabled,
    ${alias}.service_radius_km AS publicServiceRadiusKm`;
}
