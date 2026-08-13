const privateVendorLocationKeys = [
  "address",
  "latitude",
  "longitude",
  "vendorAddress",
  "vendorLatitude",
  "vendorLongitude",
  "pickupAddress",
  "pickupLatitude",
  "pickupLongitude",
] as const;

type PrivateVendorLocationKey = typeof privateVendorLocationKeys[number];

/**
 * Defense-in-depth for customer/public marketplace responses. The vendor
 * address and coordinates currently describe the private registered location,
 * not a customer-approved pickup or service point.
 */
export function redactPrivateVendorLocation<T extends Record<string, unknown>>(
  record: T,
): Omit<T, PrivateVendorLocationKey> {
  const publicRecord = { ...record };
  for (const key of privateVendorLocationKeys) delete publicRecord[key];
  return publicRecord;
}
