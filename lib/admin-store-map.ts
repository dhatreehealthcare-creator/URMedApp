export const STORE_MAP_STATUSES = ["all", "approved", "pending", "testing", "rejected", "suspended"] as const;
export const STORE_MAP_LOCATION_FILTERS = ["all", "published", "unpublished", "private_missing"] as const;
export const STORE_MAP_LIMIT = 500;

export class AdminStoreMapFilterError extends Error {
  readonly status = 400;
  constructor(message = "A store-map filter is invalid") {
    super(message);
    this.name = "AdminStoreMapFilterError";
  }
}

function enumFilter<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) throw new AdminStoreMapFilterError();
  return value as T;
}

function pattern(value: string) {
  return `%${value.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

type StoreMapRow = {
  vendorId: number; businessName: string; ownerName: string; registrationStatus: string;
  approvalStatus: string; complianceStatus: string; suspendedAt: string | null; homeDelivery: number;
  privateLatitude: string; privateLongitude: string; publicLabel: string; publicAddress: string;
  publicLatitude: string; publicLongitude: string; publicationStatus: string;
  pickupEnabled: number; serviceEnabled: number;
};

function coordinate(latitude: string, longitude: string) {
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)
    || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) return null;
  return { latitude: parsedLatitude, longitude: parsedLongitude };
}

export async function loadAdminStoreMap(database: D1Database, url: URL) {
  const status = enumFilter(url.searchParams.get("status"), STORE_MAP_STATUSES, "all");
  const location = enumFilter(url.searchParams.get("location"), STORE_MAP_LOCATION_FILTERS, "all");
  const homeDelivery = enumFilter(url.searchParams.get("homeDelivery"), ["all", "yes", "no"] as const, "all");
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const search = pattern(query);
  const common = `WITH stores AS (
    SELECT vendor.id AS vendorId,vendor.business_name AS businessName,vendor.owner_name AS ownerName,
      vendor.registration_status AS registrationStatus,vendor.approval_status AS approvalStatus,
      vendor.compliance_status AS complianceStatus,vendor.suspended_at AS suspendedAt,
      vendor.home_delivery AS homeDelivery,vendor.latitude AS privateLatitude,vendor.longitude AS privateLongitude,
      COALESCE(location.label,'') AS publicLabel,COALESCE(location.address,'') AS publicAddress,
      COALESCE(location.latitude,'') AS publicLatitude,COALESCE(location.longitude,'') AS publicLongitude,
      COALESCE(location.publication_status,'unpublished') AS publicationStatus,
      COALESCE(location.pickup_enabled,0) AS pickupEnabled,COALESCE(location.service_enabled,0) AS serviceEnabled,
      CASE WHEN vendor.suspended_at IS NOT NULL THEN 'suspended' ELSE vendor.approval_status END AS effectiveStatus
    FROM vendors vendor LEFT JOIN vendor_public_locations location ON location.vendor_id=vendor.id
  ), filtered AS (
    SELECT * FROM stores WHERE (?='all' OR effectiveStatus=?)
      AND (?='all' OR (?='yes' AND homeDelivery=1) OR (?='no' AND homeDelivery=0))
      AND (?='all' OR (?='published' AND publicationStatus='published')
        OR (?='unpublished' AND publicationStatus<>'published')
        OR (?='private_missing' AND (trim(privateLatitude)='' OR trim(privateLongitude)='')))
      AND (?='' OR lower(businessName) LIKE ? ESCAPE '\\' OR lower(ownerName) LIKE ? ESCAPE '\\'
        OR lower(publicAddress) LIKE ? ESCAPE '\\')
  )`;
  const binds = [status, status, homeDelivery, homeDelivery, homeDelivery,
    location, location, location, location, query, search, search, search];
  const [rows, count] = await Promise.all([
    database.prepare(`${common} SELECT * FROM filtered ORDER BY lower(businessName),vendorId LIMIT ?`)
      .bind(...binds, STORE_MAP_LIMIT).all<StoreMapRow>(),
    database.prepare(`${common} SELECT COUNT(*) AS total,
      SUM(CASE WHEN publicationStatus='published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN trim(privateLatitude)<>'' AND trim(privateLongitude)<>'' THEN 1 ELSE 0 END) AS privateLocated,
      SUM(CASE WHEN effectiveStatus='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN effectiveStatus='suspended' THEN 1 ELSE 0 END) AS suspended
      FROM filtered`).bind(...binds).first<Record<string, number>>(),
  ]);
  const stores = rows.results.map((row) => {
    const privatePoint = coordinate(row.privateLatitude, row.privateLongitude);
    const publicPoint = row.publicationStatus === "published"
      ? coordinate(row.publicLatitude, row.publicLongitude)
      : null;
    return {
      vendorId: row.vendorId,
      businessName: row.businessName,
      ownerName: row.ownerName,
      registrationStatus: row.registrationStatus,
      approvalStatus: row.approvalStatus,
      complianceStatus: row.complianceStatus,
      effectiveStatus: row.suspendedAt ? "suspended" : row.approvalStatus,
      homeDelivery: Boolean(row.homeDelivery),
      privatePoint,
      publicLocation: publicPoint ? {
        label: row.publicLabel,
        address: row.publicAddress,
        ...publicPoint,
        pickupEnabled: Boolean(row.pickupEnabled),
        serviceEnabled: Boolean(row.serviceEnabled),
      } : null,
    };
  });
  const total = Number(count?.total ?? 0);
  return {
    privacy: "Private legal coordinates are returned only by this administrator-authenticated endpoint. The in-app plot uses no third-party map tiles.",
    filters: { status, location, homeDelivery, query }, stores,
    counts: {
      total,
      published: Number(count?.published ?? 0),
      privateLocated: Number(count?.privateLocated ?? 0),
      approved: Number(count?.approved ?? 0),
      suspended: Number(count?.suspended ?? 0),
    },
    truncated: total > STORE_MAP_LIMIT,
  };
}
