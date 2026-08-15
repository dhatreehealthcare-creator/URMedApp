import { haversineKm, isValidGeoPoint, type GeoPoint } from "./geo.ts";

export const PUBLIC_MARKETPLACE_MAX_RADIUS_KM = 50;

export type MarketplaceOfferLocation = {
  latitude: string | number;
  longitude: string | number;
  pickupEnabled: boolean | number;
  serviceEnabled: boolean | number;
  serviceRadiusKm: number;
};

export type MarketplaceOfferProjection = {
  inventoryId: number;
  vendorId: number;
  availableQuantity: number;
  expiryDate: string | null;
  location: MarketplaceOfferLocation;
};

export type RankedMarketplaceOffer<T> = { value: T; distanceKm: number };

function enabled(value: boolean | number) {
  return value === true || value === 1;
}

export function rankMarketplaceOffers<T>(
  candidates: T[],
  customerPoint: GeoPoint,
  page: number,
  pageSize: number,
  project: (candidate: T) => MarketplaceOfferProjection,
) {
  if (!isValidGeoPoint(customerPoint)) return { offers: [] as RankedMarketplaceOffer<T>[], total: 0, hasMore: false };
  const ranked = candidates.map((value) => {
    const candidate = project(value);
    const location = {
      latitude: Number(candidate.location.latitude),
      longitude: Number(candidate.location.longitude),
    };
    const distanceKm = haversineKm(customerPoint, location);
    const radius = Number(candidate.location.serviceRadiusKm);
    const withinRadius = Number.isFinite(radius) && distanceKm <= radius;
    const serviceable = enabled(candidate.location.pickupEnabled)
      || (enabled(candidate.location.serviceEnabled) && withinRadius);
    return { value, distanceKm, candidate, serviceable };
  }).filter((entry) => Number.isFinite(entry.distanceKm)
    && entry.distanceKm <= PUBLIC_MARKETPLACE_MAX_RADIUS_KM && entry.serviceable);

  ranked.sort((left, right) => (left.distanceKm - right.distanceKm)
    || (Number(right.candidate.availableQuantity) - Number(left.candidate.availableQuantity))
    || String(left.candidate.expiryDate ?? "").localeCompare(String(right.candidate.expiryDate ?? ""))
    || (left.candidate.vendorId - right.candidate.vendorId)
    || (left.candidate.inventoryId - right.candidate.inventoryId));
  const start = Math.max(0, (page - 1) * pageSize);
  return {
    offers: ranked.slice(start, start + pageSize).map(({ value, distanceKm }) => ({ value, distanceKm })),
    total: ranked.length,
    hasMore: start + pageSize < ranked.length,
  };
}
