import { prepareAuditEventStatement } from "./audit.ts";

export const NOTIFICATION_CATEGORIES = ["transactional", "safety", "reminder", "marketing"] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];
export const NOTIFICATION_POLICY_VERSION = "URMED-NOTIFICATIONS-2026.1";
export const DEFAULT_NOTIFICATION_TIME_ZONE = "Asia/Kolkata";

export type NotificationPreference = {
  category: NotificationCategory;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: false;
  timeZone: string;
  version: number;
  updatedAt: string;
};

export class NotificationPreferenceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "NotificationPreferenceError";
    this.status = status;
  }
}

export function normalizeIanaTimeZone(value: unknown) {
  const timeZone = String(value ?? "").trim();
  if (timeZone.length < 3 || timeZone.length > 64 || (timeZone !== "UTC" && !timeZone.includes("/")) || /^SystemV\//.test(timeZone)) {
    throw new NotificationPreferenceError("Choose a supported IANA time zone");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new NotificationPreferenceError("Choose a supported IANA time zone");
  }
  return timeZone;
}

function asCategory(value: unknown): NotificationCategory {
  const category = String(value ?? "") as NotificationCategory;
  if (!NOTIFICATION_CATEGORIES.includes(category)) throw new NotificationPreferenceError("Notification category is invalid");
  return category;
}

const consentPurpose: Partial<Record<NotificationCategory, string>> = {
  reminder: "health_reminders",
  marketing: "marketing",
};

export function channelRules(category: NotificationCategory) {
  return {
    inAppRequired: category === "transactional" || category === "safety",
    emailRequiresVerifiedAddress: true as const,
    emailRequiresExplicitPreference: true as const,
    emailConsentPurpose: consentPurpose[category] ?? null,
    smsAvailable: false as const,
  };
}

export async function listNotificationPreferences(db: D1Database, profileId: number) {
  const result = await db.prepare(`SELECT category,in_app_enabled AS inAppEnabled,
    email_enabled AS emailEnabled,sms_enabled AS smsEnabled,time_zone AS timeZone,
    version,updated_at AS updatedAt FROM notification_preferences
    WHERE profile_id=? ORDER BY CASE category WHEN 'transactional' THEN 1 WHEN 'safety' THEN 2 WHEN 'reminder' THEN 3 ELSE 4 END`)
    .bind(profileId).all<Record<string, unknown>>();
  const byCategory = new Map(result.results.map((row) => [String(row.category), row]));
  return NOTIFICATION_CATEGORIES.map((category): NotificationPreference => {
    const row = byCategory.get(category);
    return {
      category,
      inAppEnabled: row ? Boolean(row.inAppEnabled) : channelRules(category).inAppRequired,
      emailEnabled: Boolean(row?.emailEnabled),
      smsEnabled: false,
      timeZone: String(row?.timeZone ?? DEFAULT_NOTIFICATION_TIME_ZONE),
      version: Number(row?.version ?? 0),
      updatedAt: String(row?.updatedAt ?? ""),
    };
  });
}

export async function notificationPreferenceSettings(db: D1Database, profileId: number) {
  const [preferences, profile, consents] = await Promise.all([
    listNotificationPreferences(db, profileId),
    db.prepare("SELECT email_verified AS emailVerified FROM account_profiles WHERE id=? AND status='active' LIMIT 1")
      .bind(profileId).first<{ emailVerified: number }>(),
    db.prepare(`SELECT consent.purpose,consent.consent_status AS consentStatus
      FROM data_consents consent WHERE consent.profile_id=? AND consent.id IN (
        SELECT MAX(latest.id) FROM data_consents latest WHERE latest.profile_id=? GROUP BY latest.purpose
      )`).bind(profileId, profileId).all<{ purpose: string; consentStatus: string }>(),
  ]);
  const granted = new Set(consents.results.filter((row) => row.consentStatus === "granted").map((row) => row.purpose));
  return {
    policyVersion: NOTIFICATION_POLICY_VERSION,
    emailVerified: Boolean(profile?.emailVerified),
    smsAvailable: false as const,
    preferences: preferences.map((preference) => ({
      ...preference,
      rules: channelRules(preference.category),
      requiredConsentGranted: consentPurpose[preference.category]
        ? granted.has(consentPurpose[preference.category]!)
        : true,
    })),
  };
}

export async function updateNotificationPreference(input: {
  db: D1Database;
  profileId: number;
  emailVerified: boolean;
  category: unknown;
  inAppEnabled: unknown;
  emailEnabled: unknown;
  smsEnabled: unknown;
  timeZone: unknown;
  expectedVersion: unknown;
  requestId?: string;
}) {
  const { db, profileId } = input;
  const category = asCategory(input.category);
  const requiredInApp = channelRules(category).inAppRequired;
  const inAppEnabled = requiredInApp || input.inAppEnabled === true;
  if (requiredInApp && input.inAppEnabled === false) {
    throw new NotificationPreferenceError("In-app notifications are required for transactional and safety events", 409);
  }
  const emailEnabled = input.emailEnabled === true;
  if (input.smsEnabled === true) throw new NotificationPreferenceError("SMS notifications are unavailable until a provider and explicit consent are configured");
  if (emailEnabled && !input.emailVerified) throw new NotificationPreferenceError("Verify your account email before enabling email notifications", 409);
  const timeZone = normalizeIanaTimeZone(input.timeZone);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new NotificationPreferenceError("Preference version is invalid");
  const requiredPurpose = consentPurpose[category];
  if ((inAppEnabled || emailEnabled) && requiredPurpose) {
    const consent = await db.prepare(`SELECT consent_status AS consentStatus FROM data_consents
      WHERE profile_id=? AND purpose=? ORDER BY id DESC LIMIT 1`).bind(profileId, requiredPurpose)
      .first<{ consentStatus: string }>();
    if (consent?.consentStatus !== "granted") {
      throw new NotificationPreferenceError(`Grant ${requiredPurpose.replaceAll("_", " ")} consent before enabling this notification category`, 409);
    }
  }
  await db.prepare(`INSERT OR IGNORE INTO notification_preferences
    (profile_id,category,in_app_enabled,email_enabled,sms_enabled,time_zone)
    VALUES (?,?,?,0,0,'${DEFAULT_NOTIFICATION_TIME_ZONE}')`).bind(profileId, category, requiredInApp ? 1 : 0).run();
  const current = await db.prepare(`SELECT in_app_enabled AS inAppEnabled,email_enabled AS emailEnabled,time_zone AS timeZone,version
    FROM notification_preferences WHERE profile_id=? AND category=? LIMIT 1`)
    .bind(profileId, category).first<{ inAppEnabled: number; emailEnabled: number; timeZone: string; version: number }>();
  if (!current) throw new NotificationPreferenceError("Notification preference is unavailable", 404);
  const unchanged = Boolean(current.inAppEnabled) === inAppEnabled
    && Boolean(current.emailEnabled) === emailEnabled && current.timeZone === timeZone;
  if (unchanged && current.version >= expectedVersion) return { updated: false as const, unchanged: true as const };
  if (current.version !== expectedVersion) throw new NotificationPreferenceError("Notification preference changed. Refresh before retrying", 409);
  const now = new Date().toISOString();
  const update = db.prepare(`UPDATE notification_preferences SET email_enabled=?,sms_enabled=0,
    in_app_enabled=?,time_zone=?,version=version+1,updated_at=?
    WHERE profile_id=? AND category=? AND version=?`)
    .bind(emailEnabled ? 1 : 0, inAppEnabled ? 1 : 0, timeZone, now, profileId, category, expectedVersion);
  const audit = await prepareAuditEventStatement({
    actorProfileId: profileId,
    action: "notification_preference.updated",
    entityType: "notification_preference",
    entityId: `${profileId}:${category}`,
    before: { inAppEnabled: Boolean(current.inAppEnabled), emailEnabled: Boolean(current.emailEnabled), timeZone: current.timeZone, version: current.version },
    after: { inAppEnabled, emailEnabled, smsEnabled: false, timeZone, version: current.version + 1 },
    requestId: input.requestId ?? "",
  }, db, { whenPreviousStatementChanged: true });
  const results = await db.batch([update, audit]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new NotificationPreferenceError("Notification preference changed. Refresh before retrying", 409);
  }
  return { updated: true as const };
}

export async function emailChannelEligibility(db: D1Database, profileId: number, category: NotificationCategory) {
  const purpose = consentPurpose[category];
  const row = await db.prepare(`SELECT profile.email_verified AS emailVerified,
    COALESCE(preference.in_app_enabled,0) AS inAppEnabled,
    COALESCE(preference.email_enabled,0) AS emailEnabled,
    COALESCE(preference.time_zone,'${DEFAULT_NOTIFICATION_TIME_ZONE}') AS timeZone,
    CASE WHEN ? IS NULL THEN 1 ELSE EXISTS(
      SELECT 1 FROM data_consents consent WHERE consent.profile_id=profile.id AND consent.purpose=?
        AND consent.id=(SELECT MAX(latest.id) FROM data_consents latest WHERE latest.profile_id=profile.id AND latest.purpose=?)
        AND consent.consent_status='granted') END AS consentGranted
    FROM account_profiles profile LEFT JOIN notification_preferences preference
      ON preference.profile_id=profile.id AND preference.category=?
    WHERE profile.id=? AND profile.status='active' LIMIT 1`)
    .bind(purpose ?? null, purpose ?? null, purpose ?? null, category, profileId)
    .first<{ emailVerified: number; inAppEnabled: number; emailEnabled: number; timeZone: string; consentGranted: number }>();
  return {
    inApp: Boolean(row && (channelRules(category).inAppRequired || row.inAppEnabled)),
    email: Boolean(row?.emailVerified && row.emailEnabled && row.consentGranted),
    sms: false as const,
    timeZone: row?.timeZone ?? DEFAULT_NOTIFICATION_TIME_ZONE,
  };
}

export async function notificationChannelEligibility(db: D1Database, profileId: number, category: NotificationCategory) {
  return emailChannelEligibility(db, profileId, category);
}
