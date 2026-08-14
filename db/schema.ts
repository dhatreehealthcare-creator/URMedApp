import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
});

// Governed pharmaceutical dosage forms are intentionally separate from
// commercial product categories. Products will gain the normalized foreign
// key as part of the structured product/variant work in P2-02.
export const dosageForms = sqliteTable("dosage_forms", {
  id: integer("id").primaryKey(),
  code: text("code").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("dosage_forms_code_uidx").on(table.code),
  uniqueIndex("dosage_forms_slug_uidx").on(table.slug),
  uniqueIndex("dosage_forms_name_uidx").on(table.name),
  uniqueIndex("dosage_forms_sort_order_uidx").on(table.sortOrder),
]);

export const manufacturers = sqliteTable("manufacturers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
}, (table) => [
  uniqueIndex("manufacturers_normalized_name_uidx").on(table.normalizedName),
]);

// Manufacturer identity stays on the recovered manufacturers table. Governance
// state and aliases are separate so recovered IDs/names remain traceable while
// every live product continues to use manufacturer_id as its canonical key.
export const manufacturerCanonicalState = sqliteTable("manufacturer_canonical_state", {
  manufacturerId: integer("manufacturer_id").primaryKey().references(() => manufacturers.id),
  status: text("status", { enum: ["active", "merged", "inactive"] }).notNull().default("active"),
  mergedIntoManufacturerId: integer("merged_into_manufacturer_id").references(() => manufacturers.id),
  source: text("source", { enum: ["recovered_catalogue", "governed_creation"] }).notNull().default("recovered_catalogue"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("manufacturer_canonical_state_status_idx").on(table.status, table.updatedAt),
  index("manufacturer_canonical_state_merge_idx").on(table.mergedIntoManufacturerId),
  check("manufacturer_canonical_state_merge_check", sql`(${table.status} = 'merged' AND ${table.mergedIntoManufacturerId} IS NOT NULL AND ${table.manufacturerId} <> ${table.mergedIntoManufacturerId}) OR (${table.status} <> 'merged' AND ${table.mergedIntoManufacturerId} IS NULL)`),
]);

export const manufacturerAliases = sqliteTable("manufacturer_aliases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  manufacturerId: integer("manufacturer_id").notNull().references(() => manufacturers.id),
  aliasName: text("alias_name").notNull(),
  normalizedAlias: text("normalized_alias").notNull(),
  provenance: text("provenance", { enum: ["recovered_catalogue", "governed_creation", "rename", "merge"] }).notNull(),
  sourceManufacturerId: integer("source_manufacturer_id").references(() => manufacturers.id),
  createdByProfileId: integer("created_by_profile_id").references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("manufacturer_aliases_normalized_uidx").on(table.normalizedAlias),
  index("manufacturer_aliases_manufacturer_idx").on(table.manufacturerId, table.createdAt),
]);

export const manufacturerChangeRequests = sqliteTable("manufacturer_change_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestType: text("request_type", { enum: ["new", "rename", "merge"] }).notNull(),
  submittedVendorId: integer("submitted_vendor_id").notNull().references(() => vendors.id),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  manufacturerId: integer("manufacturer_id").references(() => manufacturers.id),
  targetManufacturerId: integer("target_manufacturer_id").references(() => manufacturers.id),
  proposedName: text("proposed_name").notNull().default(""),
  normalizedProposedName: text("normalized_proposed_name").notNull().default(""),
  status: text("status", { enum: ["pending", "approved", "rejected", "withdrawn"] }).notNull().default("pending"),
  reviewedByProfileId: integer("reviewed_by_profile_id").references(() => accountProfiles.id),
  reviewReason: text("review_reason").notNull().default(""),
  reviewedAt: text("reviewed_at"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("manufacturer_change_requests_queue_idx").on(table.status, table.updatedAt),
  index("manufacturer_change_requests_vendor_idx").on(table.submittedVendorId, table.status, table.updatedAt),
  check("manufacturer_change_requests_pair_check", sql`${table.manufacturerId} IS NULL OR ${table.targetManufacturerId} IS NULL OR ${table.manufacturerId} <> ${table.targetManufacturerId}`),
]);

export const manufacturerGovernanceEvents = sqliteTable("manufacturer_governance_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: integer("request_id").notNull().references(() => manufacturerChangeRequests.id),
  eventType: text("event_type", { enum: ["approved_new", "approved_rename", "approved_merge", "rejected", "withdrawn"] }).notNull(),
  actorProfileId: integer("actor_profile_id").notNull().references(() => accountProfiles.id),
  manufacturerId: integer("manufacturer_id").references(() => manufacturers.id),
  targetManufacturerId: integer("target_manufacturer_id").references(() => manufacturers.id),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("manufacturer_governance_events_request_type_uidx").on(table.requestId, table.eventType),
  index("manufacturer_governance_events_manufacturer_idx").on(table.manufacturerId, table.createdAt),
]);

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  legacyId: integer("legacy_id").notNull(),
  categoryId: integer("category_id").references(() => categories.id),
  displayCategoryId: integer("display_category_id"),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  composition: text("composition").notNull().default(""),
  manufacturer: text("manufacturer").notNull().default(""),
  manufacturerId: integer("manufacturer_id").references(() => manufacturers.id),
  dosageFormId: integer("dosage_form_id").references(() => dosageForms.id),
  strengthValue: text("strength_value"),
  strengthUnit: text("strength_unit"),
  packType: text("pack_type"),
  packSizeValue: text("pack_size_value"),
  packSizeUnit: text("pack_size_unit"),
  dispensingUom: text("dispensing_uom"),
  normalizedGenericName: text("normalized_generic_name").notNull().default(""),
  normalizedTradeName: text("normalized_trade_name").notNull().default(""),
  prescriptionRequired: integer("prescription_required", { mode: "boolean" }).notNull().default(false),
  gstPercent: integer("gst_percent").notNull().default(0),
  hsnCode: text("hsn_code").notNull().default(""),
  packaging: text("packaging").notNull().default(""),
  genericName: text("generic_name").notNull().default(""),
  tradeName: text("trade_name").notNull().default(""),
  productInformation: text("product_information").notNull().default(""),
  drugSchedule: text("drug_schedule", { enum: ["OTC", "G", "H", "H1", "X", "NDPS", "UNCLASSIFIED"] }).notNull().default("UNCLASSIFIED"),
  coldChainRequired: integer("cold_chain_required", { mode: "boolean" }).notNull().default(false),
  nppaCeilingPaise: integer("nppa_ceiling_paise"),
  governanceStatus: text("governance_status", { enum: ["pending", "approved", "rejected", "inactive", "withdrawn"] }).notNull().default("pending"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  source: text("source").notNull().default("legacy_backup"),
  migratedAt: text("migrated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(""),
}, (table) => [
  uniqueIndex("products_legacy_id_uidx").on(table.legacyId),
  index("products_normalized_name_idx").on(table.normalizedName),
  index("products_category_idx").on(table.categoryId),
  index("products_manufacturer_idx").on(table.manufacturer),
  index("products_manufacturer_id_idx").on(table.manufacturerId),
  index("products_dosage_form_idx").on(table.dosageFormId),
  index("products_governance_idx").on(table.governanceStatus, table.active),
  index("products_equivalence_idx").on(
    table.normalizedGenericName,
    table.dosageFormId,
    table.strengthValue,
    table.strengthUnit,
    table.governanceStatus,
  ),
]);

// Immutable legacy-import archive. This table is not an authentication or live
// ownership source; operational customer records reference accountProfiles.
export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  legacyId: integer("legacy_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  mobile: text("mobile").notNull(),
  registeredAt: text("registered_at"),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  pincode: text("pincode").notNull().default(""),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  mobileVerified: integer("mobile_verified", { mode: "boolean" }).notNull().default(false),
  passwordResetRequired: integer("password_reset_required", { mode: "boolean" }).notNull().default(true),
  source: text("source").notNull().default("legacy_backup"),
  migratedAt: text("migrated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("customers_legacy_id_uidx").on(table.legacyId),
  uniqueIndex("customers_email_uidx").on(table.email),
  uniqueIndex("customers_mobile_uidx").on(table.mobile),
]);

export const migrationAudit = sqliteTable("migration_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceFile: text("source_file").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  entity: text("entity").notNull(),
  sourceRows: integer("source_rows").notNull(),
  importedRows: integer("imported_rows").notNull(),
  rejectedRows: integer("rejected_rows").notNull(),
  notes: text("notes").notNull().default(""),
  completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const accountProfiles = sqliteTable("account_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authUserId: text("auth_user_id").notNull(),
  role: text("role", { enum: ["customer", "vendor", "admin", "delivery"] }).notNull(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  phoneVerified: integer("phone_verified", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("account_profiles_auth_user_uidx").on(table.authUserId),
  index("account_profiles_role_idx").on(table.role),
  uniqueIndex("account_profiles_normalized_email_uidx")
    .on(sql`lower(trim(${table.email}))`)
    .where(sql`trim(${table.email}) <> ''`),
  uniqueIndex("account_profiles_phone_uidx").on(table.phone).where(sql`${table.phone} <> ''`),
]);

export const testAccounts = sqliteTable("test_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  email: text("email").notNull(),
  phone: text("phone").notNull().default(""),
  emailConfirmed: integer("email_confirmed", { mode: "boolean" }).notNull().default(false),
  phoneConfirmed: integer("phone_confirmed", { mode: "boolean" }).notNull().default(false),
  passwordSha256: text("password_sha256").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("test_accounts_profile_uidx").on(table.profileId),
  uniqueIndex("test_accounts_email_uidx").on(table.email),
]);

export const testSessions = sqliteTable("test_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  testAccountId: integer("test_account_id").notNull().references(() => testAccounts.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("test_sessions_token_uidx").on(table.tokenHash),
  index("test_sessions_account_expiry_idx").on(table.testAccountId, table.expiresAt),
]);

export const vendors = sqliteTable("vendors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").references(() => accountProfiles.id),
  businessName: text("business_name").notNull(),
  ownerName: text("owner_name").notNull(),
  phone: text("phone").notNull().default(""),
  landline: text("landline").notNull().default(""),
  email: text("email").notNull().default(""),
  gstNumber: text("gst_number").notNull().default(""),
  licenceNumber: text("licence_number").notNull().default(""),
  address: text("address").notNull().default(""),
  latitude: text("latitude").notNull().default(""),
  longitude: text("longitude").notNull().default(""),
  homeDelivery: integer("home_delivery", { mode: "boolean" }).notNull().default(false),
  registrationStatus: text("registration_status", { enum: ["draft", "submitted"] }).notNull().default("draft"),
  registrationSubmittedAt: text("registration_submitted_at"),
  approvalStatus: text("approval_status").notNull().default("testing"),
  complianceStatus: text("compliance_status").notNull().default("pending"),
  suspendedAt: text("suspended_at"),
  suspensionReason: text("suspension_reason").notNull().default(""),
  deliveryRadiusKm: integer("delivery_radius_km").notNull().default(5),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("vendors_profile_uidx").on(table.profileId),
  uniqueIndex("vendors_phone_uidx").on(table.phone).where(sql`${table.phone} <> ''`),
  uniqueIndex("vendors_email_uidx").on(table.email).where(sql`${table.email} <> ''`),
  index("vendors_approval_idx").on(table.approvalStatus),
]);

// An explicit customer-facing pickup/service point. This record is never
// backfilled from the vendor's private legal address or coordinates.
export const vendorPublicLocations = sqliteTable("vendor_public_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  label: text("label").notNull().default("Pharmacy pickup point"),
  address: text("address").notNull(),
  latitude: text("latitude").notNull(),
  longitude: text("longitude").notNull(),
  pickupEnabled: integer("pickup_enabled", { mode: "boolean" }).notNull().default(false),
  serviceEnabled: integer("service_enabled", { mode: "boolean" }).notNull().default(false),
  serviceRadiusKm: integer("service_radius_km").notNull().default(5),
  publicationStatus: text("publication_status", { enum: ["draft", "published"] }).notNull().default("draft"),
  publicationConsentAt: text("publication_consent_at"),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("vendor_public_locations_vendor_uidx").on(table.vendorId),
  index("vendor_public_locations_publication_idx").on(table.publicationStatus, table.vendorId),
]);

export const pharmacyInventory = sqliteTable("pharmacy_inventory", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  productId: integer("product_id").notNull().references(() => products.id),
  batchNumber: text("batch_number").notNull(),
  expiryDate: text("expiry_date"),
  manufacturingDate: text("manufacturing_date"),
  dosage: text("dosage").notNull().default(""),
  purchasePricePaise: integer("purchase_price_paise").notNull().default(0),
  salePricePaise: integer("sale_price_paise").notNull(),
  mrpPaise: integer("mrp_paise").notNull().default(0),
  quantity: integer("quantity").notNull().default(0),
  reservedQuantity: integer("reserved_quantity").notNull().default(0),
  gstPercent: integer("gst_percent").notNull().default(0),
  reorderLevel: integer("reorder_level").notNull().default(5),
  quarantineStatus: text("quarantine_status").notNull().default("available"),
  storageLocation: text("storage_location").notNull().default(""),
  coldChainStatus: text("cold_chain_status").notNull().default("not_applicable"),
  lastCountedAt: text("last_counted_at"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("pharmacy_inventory_batch_uidx").on(table.vendorId, table.productId, table.batchNumber),
  index("pharmacy_inventory_product_idx").on(table.productId, table.active, table.quantity),
  index("pharmacy_inventory_vendor_idx").on(table.vendorId),
]);

export const inventoryPriceHistory = sqliteTable("inventory_price_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  productId: integer("product_id").notNull().references(() => products.id),
  purchasePricePaise: integer("purchase_price_paise").notNull(),
  salePricePaise: integer("sale_price_paise").notNull(),
  mrpPaise: integer("mrp_paise").notNull(),
  gstPercent: integer("gst_percent").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveUntil: text("effective_until"),
  source: text("source").notNull().default("system"),
  reason: text("reason").notNull().default(""),
  createdByProfileId: integer("created_by_profile_id").references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("inventory_price_history_inventory_effective_idx").on(table.inventoryId, table.effectiveFrom),
  index("inventory_price_history_vendor_product_idx").on(table.vendorId, table.productId, table.effectiveFrom),
]);

export const productPackConversions = sqliteTable("product_pack_conversions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  presentationUom: text("presentation_uom").notNull(),
  baseUom: text("base_uom").notNull().default("unit"),
  baseUnitsPerPresentation: integer("base_units_per_presentation").notNull(),
  governanceStatus: text("governance_status", { enum: ["pending", "approved", "rejected", "inactive"] }).notNull().default("pending"),
  submittedVendorId: integer("submitted_vendor_id").references(() => vendors.id),
  reviewedByProfileId: integer("reviewed_by_profile_id").references(() => accountProfiles.id),
  reviewReason: text("review_reason").notNull().default(""),
  effectiveFrom: text("effective_from").notNull(),
  effectiveUntil: text("effective_until"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("product_pack_conversions_product_uom_effective_idx").on(table.productId, table.presentationUom, table.effectiveFrom),
  index("product_pack_conversions_governance_idx").on(table.productId, table.governanceStatus, table.effectiveFrom),
]);

export const productBarcodes = sqliteTable("product_barcodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  code: text("code").notNull(),
  symbology: text("symbology").notNull().default("GTIN-13"),
  status: text("status", { enum: ["pending", "approved", "rejected", "inactive"] }).notNull().default("pending"),
  submittedVendorId: integer("submitted_vendor_id").references(() => vendors.id),
  reviewedByProfileId: integer("reviewed_by_profile_id").references(() => accountProfiles.id),
  reviewReason: text("review_reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("product_barcodes_code_uidx").on(table.code),
  index("product_barcodes_product_status_idx").on(table.productId, table.status),
]);

export const inventoryAdjustmentReasonCodes = sqliteTable("inventory_adjustment_reason_codes", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  direction: text("direction", { enum: ["increase", "decrease", "both"] }).notNull(),
  requiresNotes: integer("requires_notes", { mode: "boolean" }).notNull().default(true),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_adjustment_reasons_label_uidx").on(table.label),
  index("inventory_adjustment_reasons_active_idx").on(table.active, table.sortOrder),
  check("inventory_adjustment_reasons_direction_check", sql`${table.direction} IN ('increase', 'decrease', 'both')`),
]);

export const inventoryCountSessions = sqliteTable("inventory_count_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionNumber: text("session_number").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  scopeLabel: text("scope_label").notNull(),
  notes: text("notes").notNull().default(""),
  status: text("status", { enum: ["completed"] }).notNull().default("completed"),
  lineCount: integer("line_count").notNull(),
  varianceLineCount: integer("variance_line_count").notNull(),
  netVarianceQuantity: integer("net_variance_quantity").notNull(),
  completedByProfileId: integer("completed_by_profile_id").notNull().references(() => accountProfiles.id),
  completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_count_sessions_number_uidx").on(table.sessionNumber),
  uniqueIndex("inventory_count_sessions_vendor_key_uidx").on(table.vendorId, table.idempotencyKey),
  index("inventory_count_sessions_vendor_date_idx").on(table.vendorId, table.completedAt),
  check("inventory_count_sessions_counts_check", sql`${table.lineCount} > 0 AND ${table.varianceLineCount} >= 0 AND ${table.varianceLineCount} <= ${table.lineCount}`),
]);

export const inventoryCountLines = sqliteTable("inventory_count_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  countSessionId: integer("count_session_id").notNull().references(() => inventoryCountSessions.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  expectedQuantity: integer("expected_quantity").notNull(),
  countedQuantity: integer("counted_quantity").notNull(),
  varianceQuantity: integer("variance_quantity").notNull(),
  reservedQuantitySnapshot: integer("reserved_quantity_snapshot").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_count_lines_session_inventory_uidx").on(table.countSessionId, table.inventoryId),
  index("inventory_count_lines_inventory_idx").on(table.inventoryId, table.createdAt),
  check("inventory_count_lines_quantity_check", sql`${table.expectedQuantity} >= 0 AND ${table.countedQuantity} >= 0 AND ${table.reservedQuantitySnapshot} >= 0 AND ${table.varianceQuantity} = ${table.countedQuantity} - ${table.expectedQuantity}`),
]);

export const inventoryAdjustments = sqliteTable("inventory_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  adjustmentNumber: text("adjustment_number").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  sourceType: text("source_type", { enum: ["manual", "cycle_count"] }).notNull(),
  sourceId: integer("source_id").references(() => inventoryCountSessions.id),
  reasonCode: text("reason_code").notNull().references(() => inventoryAdjustmentReasonCodes.code),
  reasonLabel: text("reason_label").notNull(),
  expectedQuantity: integer("expected_quantity").notNull(),
  quantityBefore: integer("quantity_before").notNull(),
  quantityDelta: integer("quantity_delta").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reservedQuantitySnapshot: integer("reserved_quantity_snapshot").notNull(),
  notes: text("notes").notNull().default(""),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_adjustments_number_uidx").on(table.adjustmentNumber),
  uniqueIndex("inventory_adjustments_vendor_key_uidx").on(table.vendorId, table.idempotencyKey),
  index("inventory_adjustments_vendor_date_idx").on(table.vendorId, table.createdAt),
  index("inventory_adjustments_inventory_date_idx").on(table.inventoryId, table.createdAt),
  index("inventory_adjustments_source_idx").on(table.sourceType, table.sourceId),
  check("inventory_adjustments_quantity_check", sql`${table.expectedQuantity} >= 0 AND ${table.quantityBefore} = ${table.expectedQuantity} AND ${table.quantityDelta} <> 0 AND ${table.balanceAfter} = ${table.quantityBefore} + ${table.quantityDelta} AND ${table.balanceAfter} >= 0 AND ${table.reservedQuantitySnapshot} >= 0`),
  check("inventory_adjustments_source_check", sql`(${table.sourceType} = 'manual' AND ${table.sourceId} IS NULL) OR (${table.sourceType} = 'cycle_count' AND ${table.sourceId} IS NOT NULL)`),
]);

export const customerAddresses = sqliteTable("customer_addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  label: text("label").notNull().default("Home"),
  address: text("address").notNull(),
  latitude: text("latitude").notNull().default(""),
  longitude: text("longitude").notNull().default(""),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderNumber: text("order_number").notNull(),
  customerProfileId: integer("customer_profile_id").notNull().references(() => accountProfiles.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  prescriptionId: integer("prescription_id"),
  invoiceId: integer("invoice_id"),
  orderType: text("order_type").notNull().default("online"),
  subtotalPaise: integer("subtotal_paise").notNull(),
  taxPaise: integer("tax_paise").notNull().default(0),
  deliveryFeePaise: integer("delivery_fee_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
  paymentMethod: text("payment_method", { enum: ["online", "cod"] }).notNull(),
  paymentStatus: text("payment_status").notNull().default("pending"),
  deliveryMethod: text("delivery_method", { enum: ["pickup", "pharmacy", "urmed"] }).notNull(),
  orderStatus: text("order_status").notNull().default("placed"),
  deliveryStatus: text("delivery_status").notNull().default("awaiting_confirmation"),
  prescriptionStatus: text("prescription_status").notNull().default("not_required"),
  placeOfSupplyStateCode: text("place_of_supply_state_code").notNull().default("36"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull().default(""),
  deliveryAddress: text("delivery_address").notNull().default(""),
  latitude: text("latitude").notNull().default(""),
  longitude: text("longitude").notNull().default(""),
  razorpayOrderId: text("razorpay_order_id").notNull().default(""),
  razorpayPaymentId: text("razorpay_payment_id").notNull().default(""),
  inventoryStatus: text("inventory_status", { enum: ["reserved", "committed", "released"] }).notNull().default("committed"),
  reservationExpiresAt: text("reservation_expires_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("orders_order_number_uidx").on(table.orderNumber),
  index("orders_customer_idx").on(table.customerProfileId, table.createdAt),
  index("orders_vendor_idx").on(table.vendorId, table.createdAt),
  index("orders_delivery_date_vendor_idx").on(table.deliveryMethod, table.createdAt, table.vendorId),
  index("orders_status_date_vendor_idx").on(table.orderStatus, table.createdAt, table.vendorId),
  index("orders_razorpay_idx").on(table.razorpayOrderId),
]);

export const codCollectionEvidence = sqliteTable("cod_collection_evidence", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  amountPaise: integer("amount_paise").notNull(),
  tenderMode: text("tender_mode", { enum: ["cash", "upi", "card", "bank_transfer"] }).notNull(),
  receiptReference: text("receipt_reference").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  collectorProfileId: integer("collector_profile_id").notNull().references(() => accountProfiles.id),
  collectionStatus: text("collection_status", { enum: ["collected", "voided"] }).notNull().default("collected"),
  custodyStatus: text("custody_status", { enum: ["on_hand", "deposited", "reconciled"] }).notNull().default("on_hand"),
  collectedAt: text("collected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  depositReference: text("deposit_reference").notNull().default(""),
  depositedAt: text("deposited_at"),
  depositedByProfileId: integer("deposited_by_profile_id").references(() => accountProfiles.id),
  reconciliationReference: text("reconciliation_reference").notNull().default(""),
  reconciledAt: text("reconciled_at"),
  reconciledByProfileId: integer("reconciled_by_profile_id").references(() => accountProfiles.id),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("cod_collection_order_uidx").on(table.orderId),
  uniqueIndex("cod_collection_idempotency_uidx").on(table.idempotencyKey),
  index("cod_collection_vendor_status_idx").on(table.vendorId, table.custodyStatus, table.collectedAt),
  check("cod_collection_amount_check", sql`${table.amountPaise} > 0 AND length(trim(${table.receiptReference})) BETWEEN 3 AND 120 AND length(trim(${table.idempotencyKey})) BETWEEN 8 AND 160`),
]);

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  productId: integer("product_id").notNull().references(() => products.id),
  productName: text("product_name").notNull(),
  batchNumber: text("batch_number").notNull(),
  quantity: integer("quantity").notNull(),
  unitPricePaise: integer("unit_price_paise").notNull(),
  gstPercent: integer("gst_percent").notNull().default(0),
  hsnCode: text("hsn_code").notNull().default(""),
  expiryDate: text("expiry_date"),
  taxablePaise: integer("taxable_paise").notNull().default(0),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  discountPaise: integer("discount_paise").notNull().default(0),
  lineTotalPaise: integer("line_total_paise").notNull(),
});

export const inventoryReservations = sqliteTable("inventory_reservations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  quantity: integer("quantity").notNull(),
  status: text("status", { enum: ["active", "committed", "released", "expired"] }).notNull().default("active"),
  expiresAt: text("expires_at").notNull(),
  committedAt: text("committed_at"),
  committedByProfileId: integer("committed_by_profile_id").references(() => accountProfiles.id),
  releasedAt: text("released_at"),
  statusReason: text("status_reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("inventory_reservations_order_item_uidx").on(table.orderItemId),
  index("inventory_reservations_order_status_idx").on(table.orderId, table.status),
  index("inventory_reservations_active_expiry_idx").on(table.status, table.expiresAt),
  index("inventory_reservations_inventory_status_idx").on(table.inventoryId, table.status),
]);

export const inventoryReservationRecoveryRuns = sqliteTable("inventory_reservation_recovery_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runKey: text("run_key").notNull(),
  triggerSource: text("trigger_source", { enum: ["scheduled", "manual"] }).notNull().default("scheduled"),
  scheduledAt: text("scheduled_at").notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull().default("running"),
  attempts: integer("attempts").notNull().default(1),
  batchSize: integer("batch_size").notNull(),
  maxBatches: integer("max_batches").notNull(),
  batchesProcessed: integer("batches_processed").notNull().default(0),
  ordersReleased: integer("orders_released").notNull().default(0),
  reservationsReleased: integer("reservations_released").notNull().default(0),
  remainingExpiredOrders: integer("remaining_expired_orders").notNull().default(0),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  errorMessage: text("error_message").notNull().default(""),
}, (table) => [
  uniqueIndex("inventory_reservation_recovery_runs_key_uidx").on(table.runKey),
  index("inventory_reservation_recovery_runs_started_idx").on(table.startedAt, table.status),
]);

export const deliveryEvents = sqliteTable("delivery_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  status: text("status").notNull(),
  actorProfileId: integer("actor_profile_id").references(() => accountProfiles.id),
  note: text("note").notNull().default(""),
  latitude: text("latitude").notNull().default(""),
  longitude: text("longitude").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("delivery_events_order_idx").on(table.orderId, table.createdAt)]);

export const paymentEvents = sqliteTable("payment_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerEventId: text("provider_event_id").notNull(),
  orderId: integer("order_id").references(() => orders.id),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull().default(""),
  processedAt: text("processed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("payment_events_provider_event_uidx").on(table.providerEventId)]);

export const vendorBankAccounts = sqliteTable("vendor_bank_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  bankName: text("bank_name").notNull(),
  accountName: text("account_name").notNull(),
  accountNumberEncrypted: text("account_number_encrypted").notNull(),
  accountLast4: text("account_last4").notNull().default(""),
  ifscCode: text("ifsc_code").notNull(),
  verificationStatus: text("verification_status").notNull().default("pending"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("vendor_bank_accounts_vendor_idx").on(table.vendorId, table.active)]);

export const vendorStaff = sqliteTable("vendor_staff", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  staffRole: text("staff_role", { enum: ["owner", "pharmacist", "counter_staff", "inventory_manager", "delivery_coordinator"] }).notNull(),
  permissionsJson: text("permissions_json").notNull().default("[]"),
  status: text("status").notNull().default("active"),
  invitedAt: text("invited_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  joinedAt: text("joined_at"),
}, (table) => [
  uniqueIndex("vendor_staff_vendor_profile_uidx").on(table.vendorId, table.profileId),
  index("vendor_staff_role_idx").on(table.vendorId, table.staffRole, table.status),
]);

export const storedDocuments = sqliteTable("stored_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerProfileId: integer("owner_profile_id").references(() => accountProfiles.id),
  vendorId: integer("vendor_id").references(() => vendors.id),
  purpose: text("purpose").notNull(),
  objectKey: text("object_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  malwareStatus: text("malware_status").notNull().default("pending"),
  retentionUntil: text("retention_until"),
  status: text("status").notNull().default("active"),
  uploadedAt: text("uploaded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("stored_documents_object_uidx").on(table.objectKey),
  index("stored_documents_vendor_idx").on(table.vendorId, table.purpose, table.status),
]);

export const pharmacists = sqliteTable("pharmacists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  profileId: integer("profile_id").references(() => accountProfiles.id),
  fullName: text("full_name").notNull(),
  councilName: text("council_name").notNull(),
  registrationNumber: text("registration_number").notNull(),
  validFrom: text("valid_from"),
  validUntil: text("valid_until"),
  documentId: integer("document_id").references(() => storedDocuments.id),
  verificationStatus: text("verification_status").notNull().default("pending"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("pharmacists_vendor_registration_uidx").on(table.vendorId, table.registrationNumber),
  index("pharmacists_vendor_status_idx").on(table.vendorId, table.verificationStatus, table.active),
]);

export const vendorLicences = sqliteTable("vendor_licences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  licenceNumber: text("licence_number").notNull(),
  formType: text("form_type").notNull(),
  licenceCategory: text("licence_category").notNull().default("retail"),
  issuingAuthority: text("issuing_authority").notNull(),
  issuedOn: text("issued_on"),
  validFrom: text("valid_from").notNull(),
  validUntil: text("valid_until").notNull(),
  documentId: integer("document_id").references(() => storedDocuments.id),
  verificationStatus: text("verification_status").notNull().default("pending"),
  suspendedAt: text("suspended_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("vendor_licences_vendor_number_uidx").on(table.vendorId, table.licenceNumber),
  index("vendor_licences_expiry_idx").on(table.validUntil, table.verificationStatus),
]);

export const productAlternates = sqliteTable("product_alternates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  alternateProductId: integer("alternate_product_id").notNull().references(() => products.id),
  submittedVendorId: integer("submitted_vendor_id").references(() => vendors.id),
  createdByProfileId: integer("created_by_profile_id").references(() => accountProfiles.id),
  governanceStatus: text("governance_status", { enum: ["pending", "approved", "rejected", "inactive", "withdrawn"] }).notNull().default("pending"),
  reviewedByProfileId: integer("reviewed_by_profile_id").references(() => accountProfiles.id),
  reviewReason: text("review_reason").notNull().default(""),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("product_alternates_pair_uidx").on(table.productId, table.alternateProductId),
  index("product_alternates_governance_idx").on(table.governanceStatus, table.updatedAt),
  index("product_alternates_vendor_status_idx").on(table.submittedVendorId, table.governanceStatus, table.updatedAt),
  check("product_alternates_canonical_pair_check", sql`${table.productId} < ${table.alternateProductId}`),
]);

export const productCeilingPrices = sqliteTable("product_ceiling_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  notificationNumber: text("notification_number").notNull(),
  ceilingPricePaise: integer("ceiling_price_paise").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveUntil: text("effective_until"),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("product_ceiling_prices_product_idx").on(table.productId, table.effectiveFrom),
  index("product_ceiling_prices_effective_lookup_idx").on(table.productId, table.effectiveFrom, table.effectiveUntil),
]);

export const suppliers = sqliteTable("suppliers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  businessName: text("business_name").notNull(),
  contactName: text("contact_name").notNull(),
  phone: text("phone").notNull(),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  gstNumber: text("gst_number").notNull().default(""),
  drugLicenceNumber: text("drug_licence_number").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("suppliers_vendor_business_uidx").on(table.vendorId, table.businessName),
  index("suppliers_vendor_status_idx").on(table.vendorId, table.status),
]);

export const purchaseOrders = sqliteTable("purchase_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseNumber: text("purchase_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  invoiceNumber: text("invoice_number").notNull(),
  invoiceDate: text("invoice_date").notNull(),
  subtotalPaise: integer("subtotal_paise").notNull().default(0),
  taxPaise: integer("tax_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull().default(0),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  status: text("status", { enum: ["draft", "approved", "partially_received", "received", "cancelled"] }).notNull().default("draft"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  approvedByProfileId: integer("approved_by_profile_id").references(() => accountProfiles.id),
  approvedAt: text("approved_at"),
  cancelledByProfileId: integer("cancelled_by_profile_id").references(() => accountProfiles.id),
  cancelledAt: text("cancelled_at"),
  cancellationReason: text("cancellation_reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  postedAt: text("posted_at"),
}, (table) => [
  uniqueIndex("purchase_orders_number_uidx").on(table.purchaseNumber),
  uniqueIndex("purchase_orders_vendor_invoice_uidx").on(table.vendorId, table.supplierId, table.invoiceNumber),
  index("purchase_orders_vendor_date_idx").on(table.vendorId, table.invoiceDate),
]);

export const purchaseOrderItems = sqliteTable("purchase_order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  productId: integer("product_id").notNull().references(() => products.id),
  inventoryId: integer("inventory_id").references(() => pharmacyInventory.id),
  batchNumber: text("batch_number").notNull(),
  expiryDate: text("expiry_date").notNull(),
  manufacturingDate: text("manufacturing_date"),
  dosage: text("dosage").notNull().default(""),
  quantity: integer("quantity").notNull(),
  freeQuantity: integer("free_quantity").notNull().default(0),
  purchasePricePaise: integer("purchase_price_paise").notNull(),
  salePricePaise: integer("sale_price_paise").notNull(),
  mrpPaise: integer("mrp_paise").notNull().default(0),
  gstPercent: integer("gst_percent").notNull(),
  taxablePaise: integer("taxable_paise").notNull(),
  taxPaise: integer("tax_paise").notNull(),
  lineTotalPaise: integer("line_total_paise").notNull(),
  receivedQuantity: integer("received_quantity").notNull().default(0),
  receivedFreeQuantity: integer("received_free_quantity").notNull().default(0),
}, (table) => [index("purchase_order_items_purchase_idx").on(table.purchaseOrderId)]);

export const purchaseReceipts = sqliteTable("purchase_receipts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  receiptNumber: text("receipt_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  receivedOn: text("received_on").notNull(),
  notes: text("notes").notNull().default(""),
  receivedByProfileId: integer("received_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("purchase_receipts_number_uidx").on(table.receiptNumber),
  index("purchase_receipts_order_idx").on(table.purchaseOrderId, table.createdAt),
  index("purchase_receipts_vendor_date_idx").on(table.vendorId, table.receivedOn),
]);

export const purchaseReceiptItems = sqliteTable("purchase_receipt_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseReceiptId: integer("purchase_receipt_id").notNull().references(() => purchaseReceipts.id),
  purchaseOrderItemId: integer("purchase_order_item_id").notNull().references(() => purchaseOrderItems.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  quantity: integer("quantity").notNull(),
  freeQuantity: integer("free_quantity").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("purchase_receipt_items_receipt_order_item_uidx").on(table.purchaseReceiptId, table.purchaseOrderItemId),
  index("purchase_receipt_items_order_item_idx").on(table.purchaseOrderItemId),
]);

export const supplierReturns = sqliteTable("supplier_returns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  returnNumber: text("return_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  debitNoteNumber: text("debit_note_number").notNull(),
  reason: text("reason").notNull(),
  totalPaise: integer("total_paise").notNull(),
  status: text("status").notNull().default("completed"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("supplier_returns_number_uidx").on(table.returnNumber),
  uniqueIndex("supplier_returns_debit_note_uidx").on(table.debitNoteNumber),
  index("supplier_returns_vendor_date_idx").on(table.vendorId, table.createdAt),
]);

export const supplierReturnItems = sqliteTable("supplier_return_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplierReturnId: integer("supplier_return_id").notNull().references(() => supplierReturns.id),
  purchaseOrderItemId: integer("purchase_order_item_id").notNull().references(() => purchaseOrderItems.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  quantity: integer("quantity").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  disposition: text("disposition").notNull().default("returned_to_supplier"),
}, (table) => [index("supplier_return_items_return_idx").on(table.supplierReturnId)]);

export const stockLedger = sqliteTable("stock_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  movementType: text("movement_type").notNull(),
  quantityDelta: integer("quantity_delta").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  referenceType: text("reference_type").notNull(),
  referenceId: integer("reference_id"),
  reason: text("reason").notNull().default(""),
  actorProfileId: integer("actor_profile_id").references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("stock_ledger_inventory_idx").on(table.inventoryId, table.createdAt),
  index("stock_ledger_vendor_idx").on(table.vendorId, table.createdAt),
]);

export const prescriptions = sqliteTable("prescriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prescriptionNumber: text("prescription_number").notNull(),
  customerProfileId: integer("customer_profile_id").notNull().references(() => accountProfiles.id),
  vendorId: integer("vendor_id").references(() => vendors.id),
  documentId: integer("document_id").notNull().references(() => storedDocuments.id),
  patientName: text("patient_name").notNull(),
  patientAddress: text("patient_address").notNull().default(""),
  prescriberName: text("prescriber_name").notNull().default(""),
  prescriberAddress: text("prescriber_address").notNull().default(""),
  prescribedOn: text("prescribed_on"),
  serialNumber: text("serial_number").notNull().default(""),
  status: text("status").notNull().default("uploaded"),
  rejectionReason: text("rejection_reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  reviewedAt: text("reviewed_at"),
}, (table) => [
  uniqueIndex("prescriptions_number_uidx").on(table.prescriptionNumber),
  index("prescriptions_vendor_status_idx").on(table.vendorId, table.status, table.createdAt),
  index("prescriptions_customer_idx").on(table.customerProfileId, table.createdAt),
]);

export const prescriptionItems = sqliteTable("prescription_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prescriptionId: integer("prescription_id").notNull().references(() => prescriptions.id),
  productId: integer("product_id").references(() => products.id),
  medicineText: text("medicine_text").notNull(),
  dosageText: text("dosage_text").notNull().default(""),
  durationText: text("duration_text").notNull().default(""),
  quantityApproved: integer("quantity_approved"),
}, (table) => [index("prescription_items_prescription_idx").on(table.prescriptionId)]);

export const prescriptionReviews = sqliteTable("prescription_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prescriptionId: integer("prescription_id").notNull().references(() => prescriptions.id),
  pharmacistId: integer("pharmacist_id").notNull().references(() => pharmacists.id),
  decision: text("decision", { enum: ["approved", "rejected", "clarification_required"] }).notNull(),
  notes: text("notes").notNull().default(""),
  reviewedAt: text("reviewed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("prescription_reviews_prescription_idx").on(table.prescriptionId, table.reviewedAt)]);

// Counter prescriptions are deliberately separate from customer-uploaded
// online prescriptions. A walk-in patient does not need a fabricated account,
// while an exact verified live customer may still be linked explicitly.
export const offlinePrescriptions = sqliteTable("offline_prescriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  captureNumber: text("capture_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  customerProfileId: integer("customer_profile_id").references(() => accountProfiles.id),
  documentId: integer("document_id").notNull().references(() => storedDocuments.id),
  patientName: text("patient_name").notNull(),
  patientAddress: text("patient_address").notNull(),
  prescriberName: text("prescriber_name").notNull(),
  prescriberAddress: text("prescriber_address").notNull(),
  prescribedOn: text("prescribed_on").notNull(),
  serialNumber: text("serial_number").notNull().default(""),
  status: text("status", { enum: ["uploaded", "approved", "rejected", "clarification_required"] }).notNull().default("uploaded"),
  rejectionReason: text("rejection_reason").notNull().default(""),
  capturedByProfileId: integer("captured_by_profile_id").notNull().references(() => accountProfiles.id),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("offline_prescriptions_number_uidx").on(table.captureNumber),
  uniqueIndex("offline_prescriptions_document_uidx").on(table.documentId),
  index("offline_prescriptions_vendor_status_idx").on(table.vendorId, table.status, table.createdAt),
  index("offline_prescriptions_customer_idx").on(table.customerProfileId, table.createdAt),
]);

export const offlinePrescriptionItems = sqliteTable("offline_prescription_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offlinePrescriptionId: integer("offline_prescription_id").notNull().references(() => offlinePrescriptions.id),
  productId: integer("product_id").notNull().references(() => products.id),
  medicineText: text("medicine_text").notNull(),
  quantityRequested: integer("quantity_requested").notNull(),
}, (table) => [
  uniqueIndex("offline_prescription_items_capture_product_uidx").on(table.offlinePrescriptionId, table.productId),
  check("offline_prescription_items_quantity_check", sql`${table.quantityRequested} > 0`),
]);

export const offlinePrescriptionReviews = sqliteTable("offline_prescription_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offlinePrescriptionId: integer("offline_prescription_id").notNull().references(() => offlinePrescriptions.id),
  pharmacistId: integer("pharmacist_id").notNull().references(() => pharmacists.id),
  decision: text("decision", { enum: ["approved", "rejected", "clarification_required"] }).notNull(),
  notes: text("notes").notNull().default(""),
  reviewedAt: text("reviewed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("offline_prescription_reviews_capture_uidx").on(table.offlinePrescriptionId),
  index("offline_prescription_reviews_pharmacist_idx").on(table.pharmacistId, table.reviewedAt),
]);

export const offlinePrescriptionReviewItems = sqliteTable("offline_prescription_review_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: integer("review_id").notNull().references(() => offlinePrescriptionReviews.id),
  productId: integer("product_id").notNull().references(() => products.id),
  quantityApproved: integer("quantity_approved").notNull(),
}, (table) => [
  uniqueIndex("offline_prescription_review_items_review_product_uidx").on(table.reviewId, table.productId),
  check("offline_prescription_review_items_quantity_check", sql`${table.quantityApproved} > 0`),
]);

export const offlineSales = sqliteTable("offline_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleNumber: text("sale_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  customerProfileId: integer("customer_profile_id").references(() => accountProfiles.id),
  customerName: text("customer_name").notNull().default("Walk-in customer"),
  customerPhone: text("customer_phone").notNull().default(""),
  prescriptionId: integer("prescription_id").references(() => prescriptions.id),
  offlinePrescriptionId: integer("offline_prescription_id").references(() => offlinePrescriptions.id),
  idempotencyKey: text("idempotency_key").notNull().default(""),
  requestFingerprint: text("request_fingerprint").notNull().default(""),
  grossPaise: integer("gross_paise").notNull().default(0),
  subtotalPaise: integer("subtotal_paise").notNull(),
  taxPaise: integer("tax_paise").notNull(),
  discountPaise: integer("discount_paise").notNull().default(0),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
  paymentMode: text("payment_mode").notNull(),
  buyerGstin: text("buyer_gstin").notNull().default(""),
  placeOfSupplyStateCode: text("place_of_supply_state_code").notNull().default("00"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("offline_sales_number_uidx").on(table.saleNumber),
  uniqueIndex("offline_sales_vendor_idempotency_uidx").on(table.vendorId, table.idempotencyKey).where(sql`${table.idempotencyKey} <> ''`),
  uniqueIndex("offline_sales_prescription_uidx").on(table.offlinePrescriptionId).where(sql`${table.offlinePrescriptionId} IS NOT NULL`),
  index("offline_sales_vendor_date_idx").on(table.vendorId, table.createdAt),
  check("offline_sales_payment_mode_check", sql`${table.paymentMode} IN ('cash', 'upi', 'card', 'credit')`),
  check("offline_sales_amounts_check", sql`${table.grossPaise} >= 0 AND ${table.discountPaise} >= 0 AND ${table.subtotalPaise} >= 0 AND ${table.taxPaise} >= 0 AND ${table.cgstPaise} >= 0 AND ${table.sgstPaise} >= 0 AND ${table.igstPaise} >= 0 AND ${table.totalPaise} >= 0`),
]);

export const offlineSaleItems = sqliteTable("offline_sale_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offlineSaleId: integer("offline_sale_id").notNull().references(() => offlineSales.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  productId: integer("product_id").notNull().references(() => products.id),
  batchNumber: text("batch_number").notNull(),
  expiryDate: text("expiry_date").notNull(),
  quantity: integer("quantity").notNull(),
  productName: text("product_name").notNull().default(""),
  unitPricePaise: integer("unit_price_paise").notNull(),
  gstPercent: integer("gst_percent").notNull(),
  hsnCode: text("hsn_code").notNull().default(""),
  mrpPaise: integer("mrp_paise").notNull().default(0),
  discountPaise: integer("discount_paise").notNull().default(0),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  prescriptionRequired: integer("prescription_required", { mode: "boolean" }).notNull().default(false),
  drugSchedule: text("drug_schedule", { enum: ["OTC", "G", "H", "H1", "X", "NDPS", "UNCLASSIFIED"] }).notNull().default("UNCLASSIFIED"),
  taxablePaise: integer("taxable_paise").notNull(),
  taxPaise: integer("tax_paise").notNull(),
  lineTotalPaise: integer("line_total_paise").notNull(),
}, (table) => [
  uniqueIndex("offline_sale_items_sale_inventory_uidx").on(table.offlineSaleId, table.inventoryId),
  index("offline_sale_items_sale_idx").on(table.offlineSaleId),
  check("offline_sale_items_amount_check", sql`${table.quantity} > 0 AND ${table.unitPricePaise} > 0 AND ${table.mrpPaise} >= 0 AND ${table.discountPaise} >= 0 AND ${table.taxablePaise} >= 0 AND ${table.taxPaise} >= 0 AND ${table.cgstPaise} >= 0 AND ${table.sgstPaise} >= 0 AND ${table.igstPaise} >= 0 AND ${table.lineTotalPaise} >= 0`),
]);

export const offlineSaleEvents = sqliteTable("offline_sale_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offlineSaleId: integer("offline_sale_id").notNull().references(() => offlineSales.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  eventType: text("event_type", { enum: ["completed"] }).notNull(),
  actorProfileId: integer("actor_profile_id").notNull().references(() => accountProfiles.id),
  requestFingerprint: text("request_fingerprint").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("offline_sale_events_sale_type_uidx").on(table.offlineSaleId, table.eventType),
  index("offline_sale_events_vendor_date_idx").on(table.vendorId, table.createdAt),
]);

export const salesReturns = sqliteTable("sales_returns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  returnNumber: text("return_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  sourceType: text("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  reason: text("reason").notNull(),
  creditNoteNumber: text("credit_note_number").notNull(),
  refundPaise: integer("refund_paise").notNull(),
  discountPaise: integer("discount_paise").notNull().default(0),
  taxPaise: integer("tax_paise").notNull().default(0),
  deliveryFeePaise: integer("delivery_fee_paise").notNull().default(0),
  refundMethod: text("refund_method").notNull().default("credit"),
  refundStatus: text("refund_status").notNull().default("recorded"),
  refundReference: text("refund_reference").notNull().default(""),
  providerRefundId: text("provider_refund_id"),
  idempotencyKey: text("idempotency_key").notNull().default(""),
  status: text("status").notNull().default("completed"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("sales_returns_number_uidx").on(table.returnNumber),
  uniqueIndex("sales_returns_vendor_idempotency_uidx").on(table.vendorId, table.idempotencyKey).where(sql`${table.idempotencyKey} <> ''`),
  index("sales_returns_source_idx").on(table.vendorId, table.sourceType, table.sourceId),
]);

export const salesReturnItems = sqliteTable("sales_return_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  salesReturnId: integer("sales_return_id").notNull().references(() => salesReturns.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  quantity: integer("quantity").notNull(),
  condition: text("condition").notNull(),
  disposition: text("disposition").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  sourceItemId: integer("source_item_id").notNull().default(0),
  grossPaise: integer("gross_paise").notNull().default(0),
  discountPaise: integer("discount_paise").notNull().default(0),
  taxablePaise: integer("taxable_paise").notNull().default(0),
  taxPaise: integer("tax_paise").notNull().default(0),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
});

export const returnQuarantineHolds = sqliteTable("return_quarantine_holds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  salesReturnItemId: integer("sales_return_item_id").notNull().references(() => salesReturnItems.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  quantity: integer("quantity").notNull(),
  condition: text("condition").notNull(),
  status: text("status").notNull().default("held"),
  reason: text("reason").notNull(),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("return_quarantine_holds_item_uidx").on(table.salesReturnItemId),
  index("return_quarantine_holds_vendor_idx").on(table.vendorId, table.status, table.createdAt),
]);

export const paymentRefunds = sqliteTable("payment_refunds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  customerProfileId: integer("customer_profile_id").notNull().references(() => accountProfiles.id),
  salesReturnId: integer("sales_return_id").references(() => salesReturns.id),
  providerPaymentId: text("provider_payment_id").notNull(),
  providerRefundId: text("provider_refund_id"),
  refundReceipt: text("refund_receipt").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  status: text("status", { enum: ["pending", "processed", "failed"] }).notNull().default("pending"),
  reason: text("reason").notNull(),
  failureReason: text("failure_reason").notNull().default(""),
  requestedByProfileId: integer("requested_by_profile_id").notNull().references(() => accountProfiles.id),
  initiatedAt: text("initiated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  failedAt: text("failed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("payment_refunds_order_uidx").on(table.orderId),
  uniqueIndex("payment_refunds_receipt_uidx").on(table.refundReceipt),
  uniqueIndex("payment_refunds_provider_uidx").on(table.providerRefundId),
  index("payment_refunds_customer_status_idx").on(table.customerProfileId, table.status, table.updatedAt),
  index("payment_refunds_vendor_status_idx").on(table.vendorId, table.status, table.updatedAt),
  check("payment_refunds_amount_check", sql`${table.amountPaise} > 0`),
  check("payment_refunds_reason_check", sql`length(trim(${table.reason})) >= 5`),
]);

export const taxInvoices = sqliteTable("tax_invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceNumber: text("invoice_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  sourceType: text("source_type", { enum: ["online_order", "offline_sale"] }).notNull(),
  sourceId: integer("source_id").notNull(),
  sourceNumber: text("source_number").notNull().default(""),
  sellerName: text("seller_name").notNull().default(""),
  sellerAddress: text("seller_address").notNull().default(""),
  sellerEmail: text("seller_email").notNull().default(""),
  sellerGstin: text("seller_gstin").notNull(),
  buyerName: text("buyer_name").notNull().default(""),
  buyerAddress: text("buyer_address").notNull().default(""),
  buyerGstin: text("buyer_gstin").notNull().default(""),
  placeOfSupplyStateCode: text("place_of_supply_state_code").notNull(),
  paymentMode: text("payment_mode").notNull().default(""),
  currency: text("currency").notNull().default("INR"),
  grossPaise: integer("gross_paise").notNull().default(0),
  discountPaise: integer("discount_paise").notNull().default(0),
  subtotalPaise: integer("subtotal_paise").notNull(),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  deliveryFeePaise: integer("delivery_fee_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
  irn: text("irn").notNull().default(""),
  qrCodePayload: text("qr_code_payload").notNull().default(""),
  snapshotVersion: integer("snapshot_version").notNull().default(1),
  issuedByProfileId: integer("issued_by_profile_id").references(() => accountProfiles.id),
  issuedAt: text("issued_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("tax_invoices_number_uidx").on(table.invoiceNumber),
  uniqueIndex("tax_invoices_source_uidx").on(table.sourceType, table.sourceId),
  index("tax_invoices_vendor_date_idx").on(table.vendorId, table.issuedAt),
  index("tax_invoices_source_date_idx").on(table.sourceType, table.issuedAt, table.sourceId),
  check("tax_invoices_source_check", sql`${table.sourceType} IN ('online_order', 'offline_sale') AND ${table.sourceId} > 0 AND length(trim(${table.sourceNumber})) > 0`),
  check("tax_invoices_identity_check", sql`length(trim(${table.invoiceNumber})) > 0 AND length(trim(${table.sellerName})) > 0 AND length(trim(${table.sellerAddress})) > 0 AND length(trim(${table.buyerName})) > 0 AND ${table.placeOfSupplyStateCode} GLOB '[0-9][0-9]' AND ${table.currency} = 'INR' AND ${table.snapshotVersion} = 1`),
  check("tax_invoices_amount_check", sql`${table.grossPaise} >= 0 AND ${table.discountPaise} >= 0 AND ${table.grossPaise} = ${table.subtotalPaise} + ${table.discountPaise} AND ${table.subtotalPaise} >= 0 AND ${table.cgstPaise} >= 0 AND ${table.sgstPaise} >= 0 AND ${table.igstPaise} >= 0 AND ${table.deliveryFeePaise} >= 0 AND ${table.totalPaise} = ${table.subtotalPaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise} + ${table.deliveryFeePaise}`),
]);

export const taxInvoiceLines = sqliteTable("tax_invoice_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: integer("invoice_id").notNull().references(() => taxInvoices.id),
  lineNumber: integer("line_number").notNull(),
  sourceItemId: integer("source_item_id").notNull(),
  productName: text("product_name").notNull(),
  hsnCode: text("hsn_code").notNull().default(""),
  batchNumber: text("batch_number").notNull().default(""),
  expiryDate: text("expiry_date").notNull().default(""),
  quantity: integer("quantity").notNull(),
  unitPricePaise: integer("unit_price_paise").notNull(),
  grossPaise: integer("gross_paise").notNull(),
  discountPaise: integer("discount_paise").notNull().default(0),
  taxablePaise: integer("taxable_paise").notNull(),
  gstPercent: integer("gst_percent").notNull(),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  lineTotalPaise: integer("line_total_paise").notNull(),
}, (table) => [
  uniqueIndex("tax_invoice_lines_number_uidx").on(table.invoiceId, table.lineNumber),
  uniqueIndex("tax_invoice_lines_source_uidx").on(table.invoiceId, table.sourceItemId),
  index("tax_invoice_lines_invoice_idx").on(table.invoiceId),
  check("tax_invoice_lines_amount_check", sql`${table.lineNumber} > 0 AND ${table.sourceItemId} > 0 AND length(trim(${table.productName})) > 0 AND ${table.quantity} > 0 AND ${table.unitPricePaise} > 0 AND ${table.grossPaise} = ${table.unitPricePaise} * ${table.quantity} AND ${table.discountPaise} >= 0 AND ${table.taxablePaise} = ${table.grossPaise} - ${table.discountPaise} AND ${table.taxablePaise} >= 0 AND ${table.gstPercent} IN (0, 5, 12, 18, 28) AND ${table.cgstPaise} >= 0 AND ${table.sgstPaise} >= 0 AND ${table.igstPaise} >= 0 AND ${table.lineTotalPaise} = ${table.taxablePaise} + ${table.cgstPaise} + ${table.sgstPaise} + ${table.igstPaise}`),
]);

export const expenses = sqliteTable("expenses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  purpose: text("purpose").notNull(),
  expenseHead: text("expense_head").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  expenseDate: text("expense_date").notNull(),
  paymentMode: text("payment_mode").notNull(),
  referenceNumber: text("reference_number").notNull().default(""),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("expenses_vendor_date_idx").on(table.vendorId, table.expenseDate)]);

export const ledgerEntries = sqliteTable("ledger_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  accountCode: text("account_code").notNull(),
  entryDate: text("entry_date").notNull(),
  description: text("description").notNull(),
  debitPaise: integer("debit_paise").notNull().default(0),
  creditPaise: integer("credit_paise").notNull().default(0),
  referenceType: text("reference_type").notNull(),
  referenceId: integer("reference_id"),
  createdByProfileId: integer("created_by_profile_id").references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  partyId: integer("party_id"),
}, (table) => [index("ledger_entries_vendor_date_idx").on(table.vendorId, table.entryDate), index("ledger_entries_party_date_idx").on(table.partyId, table.entryDate)]);

export const accountingParties = sqliteTable("accounting_parties", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  partyType: text("party_type", { enum: ["supplier", "customer"] }).notNull(),
  partyRefId: integer("party_ref_id").notNull(),
  displayName: text("display_name").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_parties_scope_ref_uidx").on(table.vendorId, table.partyType, table.partyRefId),
  index("accounting_parties_scope_type_idx").on(table.vendorId, table.partyType, table.active),
]);

/** Governed account master used by statements; ledger_entries remains the immutable posting source. */
export const chartAccounts = sqliteTable("chart_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountCode: text("account_code").notNull(),
  name: text("name").notNull(),
  accountType: text("account_type", { enum: ["asset", "liability", "equity", "income", "expense"] }).notNull(),
  normalBalance: text("normal_balance", { enum: ["debit", "credit"] }).notNull(),
  parentCode: text("parent_code"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  system: integer("system", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("chart_accounts_code_uidx").on(table.accountCode),
  index("chart_accounts_type_idx").on(table.accountType, table.active),
]);

export const accountingOpeningBalances = sqliteTable("accounting_opening_balances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  accountCode: text("account_code").notNull().references(() => chartAccounts.accountCode),
  asOfDate: text("as_of_date").notNull(),
  debitPaise: integer("debit_paise").notNull().default(0),
  creditPaise: integer("credit_paise").notNull().default(0),
  description: text("description").notNull().default("Opening balance"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_opening_balances_scope_uidx").on(table.vendorId, table.accountCode, table.asOfDate),
  index("accounting_opening_balances_vendor_date_idx").on(table.vendorId, table.asOfDate),
  check("accounting_opening_balances_amount_check", sql`(${table.debitPaise} >= 0 AND ${table.creditPaise} >= 0 AND NOT (${table.debitPaise} > 0 AND ${table.creditPaise} > 0))`),
]);

export const accountingPeriods = sqliteTable("accounting_periods", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  closedByProfileId: integer("closed_by_profile_id").references(() => accountProfiles.id),
  closedAt: text("closed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_periods_scope_dates_uidx").on(table.vendorId, table.periodStart, table.periodEnd),
  index("accounting_periods_scope_status_idx").on(table.vendorId, table.status, table.periodEnd),
  check("accounting_periods_dates_check", sql`date(${table.periodEnd}) >= date(${table.periodStart})`),
]);

export const accountingReconciliations = sqliteTable("accounting_reconciliations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  accountCode: text("account_code").notNull().references(() => chartAccounts.accountCode),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  ledgerPaise: integer("ledger_paise").notNull(),
  statementPaise: integer("statement_paise").notNull(),
  variancePaise: integer("variance_paise").notNull(),
  status: text("status", { enum: ["pending", "matched", "exception"] }).notNull(),
  note: text("note").notNull().default(""),
  reviewedByProfileId: integer("reviewed_by_profile_id").references(() => accountProfiles.id),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_reconciliations_scope_uidx").on(table.vendorId, table.accountCode, table.periodStart, table.periodEnd),
  index("accounting_reconciliations_status_idx").on(table.vendorId, table.status, table.periodEnd),
]);

export const accountingReconciliationItems = sqliteTable("accounting_reconciliation_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  accountCode: text("account_code").notNull().references(() => chartAccounts.accountCode),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  externalReference: text("external_reference").notNull(),
  externalDate: text("external_date").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  matchedLedgerEntryId: integer("matched_ledger_entry_id").references(() => ledgerEntries.id),
  status: text("status", { enum: ["unmatched", "matched", "ignored"] }).notNull().default("unmatched"),
  note: text("note").notNull().default(""),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  matchedByProfileId: integer("matched_by_profile_id").references(() => accountProfiles.id),
  matchedAt: text("matched_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_reconciliation_items_ref_uidx").on(table.vendorId, table.accountCode, table.externalReference),
  index("accounting_reconciliation_items_match_idx").on(table.vendorId, table.accountCode, table.status, table.externalDate),
]);

export const accountingStatementImports = sqliteTable("accounting_statement_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  accountCode: text("account_code").notNull().references(() => chartAccounts.accountCode),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  sourceName: text("source_name").notNull(),
  sourceChecksum: text("source_checksum").notNull(),
  rowCount: integer("row_count").notNull(),
  status: text("status", { enum: ["staged", "approved", "reversed"] }).notNull().default("staged"),
  importedByProfileId: integer("imported_by_profile_id").notNull().references(() => accountProfiles.id),
  approvedByProfileId: integer("approved_by_profile_id").references(() => accountProfiles.id),
  approvedAt: text("approved_at"),
  reversedByProfileId: integer("reversed_by_profile_id").references(() => accountProfiles.id),
  reversedAt: text("reversed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_statement_imports_checksum_uidx").on(table.vendorId, table.accountCode, table.sourceChecksum),
  index("accounting_statement_imports_scope_date_idx").on(table.vendorId, table.accountCode, table.periodEnd),
]);

export const accountingReconciliationMatches = sqliteTable("accounting_reconciliation_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reconciliationItemId: integer("reconciliation_item_id").notNull().references(() => accountingReconciliationItems.id),
  ledgerEntryId: integer("ledger_entry_id").notNull().references(() => ledgerEntries.id),
  amountPaise: integer("amount_paise").notNull(),
  status: text("status", { enum: ["proposed", "approved", "reversed"] }).notNull().default("proposed"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  approvedByProfileId: integer("approved_by_profile_id").references(() => accountProfiles.id),
  approvedAt: text("approved_at"),
  reversedByProfileId: integer("reversed_by_profile_id").references(() => accountProfiles.id),
  reversedAt: text("reversed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_reconciliation_matches_pair_uidx").on(table.reconciliationItemId, table.ledgerEntryId),
  index("accounting_reconciliation_matches_item_status_idx").on(table.reconciliationItemId, table.status),
  check("accounting_reconciliation_matches_amount_check", sql`${table.amountPaise} > 0`),
]);

/** External accountant approval is recorded here; no code path may infer approval from an admin login. */
export const accountingPolicyApprovals = sqliteTable("accounting_policy_approvals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  policyKey: text("policy_key").notNull(),
  policyVersion: text("policy_version").notNull(),
  decision: text("decision", { enum: ["approved", "revoked"] }).notNull(),
  approvalReference: text("approval_reference").notNull(),
  approvedByProfileId: integer("approved_by_profile_id").notNull().references(() => accountProfiles.id),
  approvedAt: text("approved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("accounting_policy_approvals_version_uidx").on(table.policyKey, table.policyVersion),
  index("accounting_policy_approvals_active_idx").on(table.policyKey, table.decision, table.approvedAt),
]);

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").references(() => accountProfiles.id),
  vendorId: integer("vendor_id").references(() => vendors.id),
  notificationType: text("notification_type").notNull(),
  severity: text("severity").notNull().default("info"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  referenceType: text("reference_type").notNull().default(""),
  referenceId: integer("reference_id"),
  readAt: text("read_at"),
  lifecycleStatus: text("lifecycle_status", { enum: ["unread", "read", "acknowledged", "snoozed", "resolved"] }).notNull().default("unread"),
  acknowledgedAt: text("acknowledged_at"),
  snoozedUntil: text("snoozed_until"),
  resolvedAt: text("resolved_at"),
  resolutionReason: text("resolution_reason").notNull().default(""),
  lifecycleVersion: integer("lifecycle_version").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("notifications_vendor_read_idx").on(table.vendorId, table.readAt, table.createdAt),
  index("notifications_vendor_lifecycle_idx").on(table.vendorId, table.lifecycleStatus, table.snoozedUntil, table.createdAt),
  uniqueIndex("notifications_vendor_inventory_active_uidx")
    .on(table.vendorId, table.referenceType, table.referenceId)
    .where(sql`${table.vendorId} IS NOT NULL AND ${table.notificationType} IN ('inventory_near_expiry', 'inventory_low_stock', 'inventory_zero_stock') AND ${table.lifecycleStatus} <> 'resolved'`),
]);

export const notificationPreferences = sqliteTable("notification_preferences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  category: text("category", { enum: ["transactional", "safety", "reminder", "marketing"] }).notNull(),
  inAppEnabled: integer("in_app_enabled", { mode: "boolean" }).notNull().default(true),
  emailEnabled: integer("email_enabled", { mode: "boolean" }).notNull().default(false),
  smsEnabled: integer("sms_enabled", { mode: "boolean" }).notNull().default(false),
  timeZone: text("time_zone").notNull().default("Asia/Kolkata"),
  version: integer("version").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("notification_preferences_profile_category_uidx").on(table.profileId, table.category),
  index("notification_preferences_profile_idx").on(table.profileId, table.updatedAt),
  check("notification_preferences_channel_check", sql`(${table.category} NOT IN ('transactional', 'safety') OR ${table.inAppEnabled} = 1) AND ${table.smsEnabled} = 0 AND ${table.version} >= 0`),
]);

export const transactionalEmailOutbox = sqliteTable("transactional_email_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  recipientEmail: text("recipient_email").notNull(),
  category: text("category", { enum: ["transactional", "safety", "reminder"] }).notNull(),
  eventType: text("event_type", { enum: ["order_placed", "order_status_changed", "prescription_reviewed", "refill_due", "pill_due"] }).notNull(),
  payloadJson: text("payload_json").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status", { enum: ["queued", "processing", "sent", "retry_wait", "dead_letter", "cancelled"] }).notNull().default("queued"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  nextAttemptAt: text("next_attempt_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  leaseOwner: text("lease_owner").notNull().default(""),
  leaseExpiresAt: text("lease_expires_at"),
  providerMessageId: text("provider_message_id").notNull().default(""),
  lastErrorCode: text("last_error_code").notNull().default(""),
  lastErrorReason: text("last_error_reason").notNull().default(""),
  sentAt: text("sent_at"),
  deadLetteredAt: text("dead_lettered_at"),
  cancelledAt: text("cancelled_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("transactional_email_outbox_dedupe_uidx").on(table.dedupeKey),
  index("transactional_email_outbox_due_idx").on(table.status, table.nextAttemptAt, table.id),
  index("transactional_email_outbox_lease_idx").on(table.status, table.leaseExpiresAt, table.id),
  index("transactional_email_outbox_profile_idx").on(table.profileId, table.createdAt),
  check("transactional_email_outbox_attempt_check", sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 12 AND ${table.attemptCount} <= ${table.maxAttempts}`),
]);

export const reminderDeliveryEvidence = sqliteTable("reminder_delivery_evidence", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reminderType: text("reminder_type", { enum: ["pill", "refill"] }).notNull(),
  reminderId: integer("reminder_id").notNull(),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  localDate: text("local_date").notNull(),
  channel: text("channel", { enum: ["email", "in_app"] }).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  outboxId: integer("outbox_id").references(() => transactionalEmailOutbox.id),
  status: text("status", { enum: ["queued", "processing", "sent", "retry_wait", "dead_letter", "cancelled"] }).notNull().default("queued"),
  providerMessageId: text("provider_message_id").notNull().default(""),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code").notNull().default(""),
  lastErrorReason: text("last_error_reason").notNull().default(""),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("reminder_delivery_evidence_dedupe_uidx").on(table.dedupeKey),
  uniqueIndex("reminder_delivery_evidence_day_uidx").on(table.reminderType, table.reminderId, table.localDate, table.channel),
  index("reminder_delivery_evidence_profile_idx").on(table.profileId, table.createdAt),
  index("reminder_delivery_evidence_status_idx").on(table.status, table.updatedAt),
]);

export const pillReminders = sqliteTable("pill_reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerProfileId: integer("customer_profile_id").notNull().references(() => accountProfiles.id),
  productId: integer("product_id").references(() => products.id),
  medicineName: text("medicine_name").notNull(),
  dosageInstructions: text("dosage_instructions").notNull().default(""),
  reminderTime: text("reminder_time").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  recurrenceRule: text("recurrence_rule").notNull().default("daily"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("pill_reminders_customer_idx").on(table.customerProfileId, table.active)]);

export const refillReminders = sqliteTable("refill_reminders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customerProfileId: integer("customer_profile_id").notNull().references(() => accountProfiles.id),
  sourceOrderId: integer("source_order_id").notNull().references(() => orders.id),
  sourceOrderItemId: integer("source_order_item_id").notNull().references(() => orderItems.id),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  productId: integer("product_id").notNull().references(() => products.id),
  medicineName: text("medicine_name").notNull(),
  originalQuantity: integer("original_quantity").notNull().default(1),
  daysSupply: integer("days_supply").notNull().default(30),
  dueDate: text("due_date").notNull(),
  reminderLeadDays: integer("reminder_lead_days").notNull().default(3),
  status: text("status").notNull().default("active"),
  snoozedUntil: text("snoozed_until"),
  lastNotifiedAt: text("last_notified_at"),
  repeatOrderId: integer("repeat_order_id").references(() => orders.id),
  scheduleSource: text("schedule_source").notNull().default("estimated"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("refill_reminders_source_item_uidx").on(table.sourceOrderItemId),
  index("refill_reminders_customer_due_idx").on(table.customerProfileId, table.status, table.dueDate),
  index("refill_reminders_vendor_due_idx").on(table.vendorId, table.status, table.dueDate),
]);

export const deliveryAgents = sqliteTable("delivery_agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  vehicleType: text("vehicle_type").notNull().default("bike"),
  vehicleNumber: text("vehicle_number").notNull().default(""),
  licenceNumber: text("licence_number").notNull().default(""),
  availabilityStatus: text("availability_status").notNull().default("offline"),
  currentLatitude: text("current_latitude").notNull().default(""),
  currentLongitude: text("current_longitude").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("delivery_agents_profile_uidx").on(table.profileId)]);

export const deliveryAssignments = sqliteTable("delivery_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").notNull().references(() => orders.id),
  agentId: integer("agent_id").notNull().references(() => deliveryAgents.id),
  assignedByProfileId: integer("assigned_by_profile_id").references(() => accountProfiles.id),
  assignedAt: text("assigned_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  acceptedAt: text("accepted_at"),
  pickedUpAt: text("picked_up_at"),
  deliveredAt: text("delivered_at"),
  status: text("status").notNull().default("assigned"),
  proofDocumentId: integer("proof_document_id").references(() => storedDocuments.id),
}, (table) => [index("delivery_assignments_order_idx").on(table.orderId, table.status)]);

export const statutoryRegisterEntries = sqliteTable("statutory_register_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  registerType: text("register_type", { enum: ["H1", "X", "NDPS", "PRESCRIPTION"] }).notNull(),
  serialNumber: text("serial_number").notNull(),
  transactionDate: text("transaction_date").notNull(),
  patientName: text("patient_name").notNull(),
  patientAddress: text("patient_address").notNull(),
  prescriberName: text("prescriber_name").notNull(),
  prescriberAddress: text("prescriber_address").notNull(),
  productId: integer("product_id").notNull().references(() => products.id),
  batchNumber: text("batch_number").notNull(),
  quantitySupplied: integer("quantity_supplied").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  pharmacistId: integer("pharmacist_id").notNull().references(() => pharmacists.id),
  retentionUntil: text("retention_until").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("statutory_register_vendor_serial_uidx").on(table.vendorId, table.registerType, table.serialNumber),
  index("statutory_register_date_idx").on(table.vendorId, table.registerType, table.transactionDate),
]);

export const temperatureLogs = sqliteTable("temperature_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  storageLocation: text("storage_location").notNull(),
  inventoryId: integer("inventory_id").references(() => pharmacyInventory.id),
  temperatureCelsiusX10: integer("temperature_celsius_x10").notNull(),
  withinRange: integer("within_range", { mode: "boolean" }).notNull(),
  excursionAction: text("excursion_action").notNull().default(""),
  recordedByProfileId: integer("recorded_by_profile_id").references(() => accountProfiles.id),
  recordedAt: text("recorded_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("temperature_logs_vendor_date_idx").on(table.vendorId, table.recordedAt)]);

export const dataConsents = sqliteTable("data_consents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  purpose: text("purpose").notNull(),
  policyVersion: text("policy_version").notNull(),
  consentStatus: text("consent_status").notNull(),
  capturedIpHash: text("captured_ip_hash").notNull().default(""),
  grantedAt: text("granted_at"),
  withdrawnAt: text("withdrawn_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("data_consents_profile_purpose_idx").on(table.profileId, table.purpose, table.createdAt)]);

export const retentionPolicies = sqliteTable("retention_policies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recordType: text("record_type").notNull(),
  retentionMonths: integer("retention_months").notNull(),
  legalBasis: text("legal_basis").notNull(),
  disposalMethod: text("disposal_method").notNull(),
  activeFrom: text("active_from").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("retention_policies_record_uidx").on(table.recordType, table.activeFrom)]);

export const breachIncidents = sqliteTable("breach_incidents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  incidentNumber: text("incident_number").notNull(),
  detectedAt: text("detected_at").notNull(),
  description: text("description").notNull(),
  affectedRecordTypes: text("affected_record_types").notNull(),
  affectedCount: integer("affected_count").notNull().default(0),
  containmentAction: text("containment_action").notNull().default(""),
  notificationStatus: text("notification_status").notNull().default("assessment_pending"),
  closedAt: text("closed_at"),
  createdByProfileId: integer("created_by_profile_id").references(() => accountProfiles.id),
}, (table) => [uniqueIndex("breach_incidents_number_uidx").on(table.incidentNumber)]);

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendorId: integer("vendor_id").references(() => vendors.id),
  actorProfileId: integer("actor_profile_id").references(() => accountProfiles.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  beforeJson: text("before_json").notNull().default(""),
  afterJson: text("after_json").notNull().default(""),
  reason: text("reason").notNull().default(""),
  requestId: text("request_id").notNull().default(""),
  previousEventHash: text("previous_event_hash").notNull().default(""),
  eventHash: text("event_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("audit_events_hash_uidx").on(table.eventHash),
  index("audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt),
  index("audit_events_vendor_idx").on(table.vendorId, table.createdAt),
]);

export const backupRuns = sqliteTable("backup_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  backupType: text("backup_type").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),
  verificationStatus: text("verification_status").notNull().default("pending"),
  restoreTestedAt: text("restore_tested_at"),
  objectKey: text("object_key").notNull().default(""),
  checksumSha256: text("checksum_sha256").notNull().default(""),
  notes: text("notes").notNull().default(""),
}, (table) => [index("backup_runs_started_idx").on(table.startedAt, table.status)]);
