export const REGISTRATION_ROLES = ["all", "vendor", "customer", "delivery", "admin"] as const;
export const REGISTRATION_STATUSES = ["all", "active", "inactive", "suspended"] as const;

export class AdminRegistrationFilterError extends Error {
  readonly status = 400;

  constructor(message = "A registration filter is invalid") {
    super(message);
    this.name = "AdminRegistrationFilterError";
  }
}

function enumFilter<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) throw new AdminRegistrationFilterError();
  return value as T;
}

function integer(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new AdminRegistrationFilterError();
  return parsed;
}

function optionalDate(value: string | null) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new AdminRegistrationFilterError("Registration dates must use YYYY-MM-DD");
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new AdminRegistrationFilterError("Registration dates must use YYYY-MM-DD");
  }
  return normalized;
}

function searchPattern(value: string) {
  return `%${value.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

type RegistrationRow = {
  profileId: number;
  role: "vendor" | "customer" | "delivery" | "admin";
  name: string;
  email: string;
  phone: string;
  emailVerified: number;
  phoneVerified: number;
  accountStatus: string;
  registeredAt: string;
  vendorId: number | null;
  businessName: string;
  registrationStatus: string;
  approvalStatus: string;
  complianceStatus: string;
};

export async function listAdminRegistrations(database: D1Database, url: URL) {
  const role = enumFilter(url.searchParams.get("role"), REGISTRATION_ROLES, "all");
  const status = enumFilter(url.searchParams.get("status"), REGISTRATION_STATUSES, "all");
  const query = String(url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const dateFrom = optionalDate(url.searchParams.get("dateFrom"));
  const dateTo = optionalDate(url.searchParams.get("dateTo"));
  if (dateFrom && dateTo && dateFrom > dateTo) throw new AdminRegistrationFilterError("Registration start date must not be after its end date");
  const page = integer(url.searchParams.get("page"), 1, 1, 100_000);
  const pageSize = integer(url.searchParams.get("pageSize"), 25, 5, 100);
  const search = searchPattern(query);
  const common = `WITH base AS (
      SELECT profile.id AS profileId,profile.role,profile.name,profile.email,profile.phone,
        profile.email_verified AS emailVerified,profile.phone_verified AS phoneVerified,
        profile.status AS profileStatus,profile.created_at AS registeredAt,
        COALESCE(owner_vendor.id,(SELECT staff.vendor_id FROM vendor_staff staff
          WHERE staff.profile_id=profile.id AND staff.status='active' ORDER BY staff.id DESC LIMIT 1)) AS vendorId
      FROM account_profiles profile LEFT JOIN vendors owner_vendor ON owner_vendor.profile_id=profile.id
    ), registrations AS (
      SELECT base.profileId,base.role,base.name,base.email,base.phone,base.emailVerified,base.phoneVerified,
        CASE WHEN base.profileStatus<>'active' THEN base.profileStatus
          WHEN vendor.suspended_at IS NOT NULL THEN 'suspended' ELSE 'active' END AS accountStatus,
        base.registeredAt,base.vendorId,COALESCE(vendor.business_name,'') AS businessName,
        COALESCE(vendor.registration_status,'') AS registrationStatus,
        COALESCE(vendor.approval_status,'') AS approvalStatus,
        COALESCE(vendor.compliance_status,'') AS complianceStatus
      FROM base LEFT JOIN vendors vendor ON vendor.id=base.vendorId
    ), filtered AS (
      SELECT * FROM registrations WHERE (?='all' OR role=?) AND (?='all' OR accountStatus=?)
        AND (?='' OR date(registeredAt)>=date(?)) AND (?='' OR date(registeredAt)<=date(?))
        AND (?='' OR lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
          OR lower(phone) LIKE ? ESCAPE '\\' OR lower(businessName) LIKE ? ESCAPE '\\')
    )`;
  const binds = [role, role, status, status, dateFrom, dateFrom, dateTo, dateTo,
    query, search, search, search, search];
  const [rows, totalRow, counts] = await Promise.all([
    database.prepare(`${common} SELECT * FROM filtered ORDER BY datetime(registeredAt) DESC,profileId DESC LIMIT ? OFFSET ?`)
      .bind(...binds, pageSize, (page - 1) * pageSize).all<RegistrationRow>(),
    database.prepare(`${common} SELECT COUNT(*) AS total FROM filtered`).bind(...binds).first<{ total: number }>(),
    database.prepare(`${common} SELECT COUNT(*) AS total,
      SUM(CASE WHEN role='vendor' THEN 1 ELSE 0 END) AS vendors,
      SUM(CASE WHEN role='customer' THEN 1 ELSE 0 END) AS customers,
      SUM(CASE WHEN role='delivery' THEN 1 ELSE 0 END) AS delivery,
      SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END) AS administrators,
      SUM(CASE WHEN accountStatus='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN accountStatus='inactive' THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN accountStatus='suspended' THEN 1 ELSE 0 END) AS suspended
      FROM filtered`).bind(...binds).first<Record<string, number>>(),
  ]);
  const total = Number(totalRow?.total ?? 0);
  return {
    categoryDefinition: "Account category means the live account role: vendor, customer, delivery, or administrator. Product categories are governed separately.",
    filters: { role, status, query, dateFrom, dateTo },
    registrations: rows.results.map((row) => ({
      ...row,
      verificationStatus: row.emailVerified && row.phoneVerified
        ? "verified"
        : row.emailVerified ? "phone_pending" : row.phoneVerified ? "email_pending" : "email_and_phone_pending",
    })),
    counts: {
      total: Number(counts?.total ?? 0),
      vendors: Number(counts?.vendors ?? 0),
      customers: Number(counts?.customers ?? 0),
      delivery: Number(counts?.delivery ?? 0),
      administrators: Number(counts?.administrators ?? 0),
      active: Number(counts?.active ?? 0),
      inactive: Number(counts?.inactive ?? 0),
      suspended: Number(counts?.suspended ?? 0),
    },
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}
