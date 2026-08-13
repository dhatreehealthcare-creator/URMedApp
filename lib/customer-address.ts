import { isValidGeoPoint } from "./geo.ts";

function text(value: unknown, maximum: number) {
  return String(value ?? "").trim().slice(0, maximum);
}

export class CustomerAddressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerAddressValidationError";
  }
}

export function validateCustomerAddress(input: Record<string, unknown>) {
  const label = text(input.label, 60) || "Home";
  const address = text(input.address, 600);
  const latitudeNumber = Number(input.latitude);
  const longitudeNumber = Number(input.longitude);
  if (address.length < 8) throw new CustomerAddressValidationError("Enter a complete delivery address");
  if (!isValidGeoPoint({ latitude: latitudeNumber, longitude: longitudeNumber })) {
    throw new CustomerAddressValidationError("Select a valid delivery location on the map");
  }
  return {
    label,
    address,
    latitude: latitudeNumber.toFixed(6),
    longitude: longitudeNumber.toFixed(6),
    isDefault: input.isDefault === true || input.isDefault === 1 || input.isDefault === "1",
  };
}
