export type GeoPoint = { latitude: number; longitude: number };

const EARTH_RADIUS_KM = 6371.0088;

export function isValidGeoPoint(point: GeoPoint) {
  return Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
    && Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

export function haversineKm(origin: GeoPoint, destination: GeoPoint) {
  if (!isValidGeoPoint(origin) || !isValidGeoPoint(destination)) return Number.NaN;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLatitude = radians(destination.latitude - origin.latitude);
  const deltaLongitude = radians(destination.longitude - origin.longitude);
  const latitude1 = radians(origin.latitude);
  const latitude2 = radians(destination.latitude);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isWithinDeliveryRadius(origin: GeoPoint, destination: GeoPoint, radiusKm: number) {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return false;
  const distance = haversineKm(origin, destination);
  return Number.isFinite(distance) && distance <= radiusKm;
}

export function formatDistance(distanceKm: number) {
  if (!Number.isFinite(distanceKm)) return "Distance unavailable";
  if (distanceKm < 1) return `${Math.max(1, Math.round(distanceKm * 1000))} m away`;
  return `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} km away`;
}
