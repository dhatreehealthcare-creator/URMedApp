import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
});

export const manufacturers = sqliteTable("manufacturers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
}, (table) => [
  uniqueIndex("manufacturers_normalized_name_uidx").on(table.normalizedName),
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
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  source: text("source").notNull().default("legacy_backup"),
  migratedAt: text("migrated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(""),
}, (table) => [
  uniqueIndex("products_legacy_id_uidx").on(table.legacyId),
  index("products_normalized_name_idx").on(table.normalizedName),
  index("products_category_idx").on(table.categoryId),
  index("products_manufacturer_idx").on(table.manufacturer),
]);

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
  index("account_profiles_email_idx").on(table.email),
  uniqueIndex("account_profiles_phone_uidx").on(table.phone).where(sql`${table.phone} <> ''`),
]);

export const testAccounts = sqliteTable("test_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => accountProfiles.id),
  email: text("email").notNull(),
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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("orders_order_number_uidx").on(table.orderNumber),
  index("orders_customer_idx").on(table.customerProfileId, table.createdAt),
  index("orders_vendor_idx").on(table.vendorId, table.createdAt),
  index("orders_razorpay_idx").on(table.razorpayOrderId),
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
  productId: integer("product_id").notNull().references(() => products.id),
  alternateProductId: integer("alternate_product_id").notNull().references(() => products.id),
  createdByProfileId: integer("created_by_profile_id").references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("product_alternates_pair_uidx").on(table.productId, table.alternateProductId)]);

export const productCeilingPrices = sqliteTable("product_ceiling_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => products.id),
  notificationNumber: text("notification_number").notNull(),
  ceilingPricePaise: integer("ceiling_price_paise").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveUntil: text("effective_until"),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("product_ceiling_prices_product_idx").on(table.productId, table.effectiveFrom)]);

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
  status: text("status").notNull().default("draft"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
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
}, (table) => [index("purchase_order_items_purchase_idx").on(table.purchaseOrderId)]);

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

export const offlineSales = sqliteTable("offline_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  saleNumber: text("sale_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  customerName: text("customer_name").notNull().default("Walk-in customer"),
  customerPhone: text("customer_phone").notNull().default(""),
  prescriptionId: integer("prescription_id").references(() => prescriptions.id),
  subtotalPaise: integer("subtotal_paise").notNull(),
  taxPaise: integer("tax_paise").notNull(),
  discountPaise: integer("discount_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
  paymentMode: text("payment_mode").notNull(),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("offline_sales_number_uidx").on(table.saleNumber),
  index("offline_sales_vendor_date_idx").on(table.vendorId, table.createdAt),
]);

export const offlineSaleItems = sqliteTable("offline_sale_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  offlineSaleId: integer("offline_sale_id").notNull().references(() => offlineSales.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  productId: integer("product_id").notNull().references(() => products.id),
  batchNumber: text("batch_number").notNull(),
  expiryDate: text("expiry_date").notNull(),
  quantity: integer("quantity").notNull(),
  unitPricePaise: integer("unit_price_paise").notNull(),
  gstPercent: integer("gst_percent").notNull(),
  taxablePaise: integer("taxable_paise").notNull(),
  taxPaise: integer("tax_paise").notNull(),
  lineTotalPaise: integer("line_total_paise").notNull(),
}, (table) => [index("offline_sale_items_sale_idx").on(table.offlineSaleId)]);

export const salesReturns = sqliteTable("sales_returns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  returnNumber: text("return_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  sourceType: text("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  reason: text("reason").notNull(),
  creditNoteNumber: text("credit_note_number").notNull(),
  refundPaise: integer("refund_paise").notNull(),
  status: text("status").notNull().default("completed"),
  createdByProfileId: integer("created_by_profile_id").notNull().references(() => accountProfiles.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("sales_returns_number_uidx").on(table.returnNumber)]);

export const salesReturnItems = sqliteTable("sales_return_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  salesReturnId: integer("sales_return_id").notNull().references(() => salesReturns.id),
  inventoryId: integer("inventory_id").notNull().references(() => pharmacyInventory.id),
  quantity: integer("quantity").notNull(),
  condition: text("condition").notNull(),
  disposition: text("disposition").notNull(),
  amountPaise: integer("amount_paise").notNull(),
});

export const taxInvoices = sqliteTable("tax_invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceNumber: text("invoice_number").notNull(),
  vendorId: integer("vendor_id").notNull().references(() => vendors.id),
  sourceType: text("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  sellerGstin: text("seller_gstin").notNull(),
  buyerGstin: text("buyer_gstin").notNull().default(""),
  placeOfSupplyStateCode: text("place_of_supply_state_code").notNull(),
  subtotalPaise: integer("subtotal_paise").notNull(),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
  irn: text("irn").notNull().default(""),
  qrCodePayload: text("qr_code_payload").notNull().default(""),
  issuedAt: text("issued_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("tax_invoices_number_uidx").on(table.invoiceNumber),
  index("tax_invoices_vendor_date_idx").on(table.vendorId, table.issuedAt),
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
}, (table) => [index("ledger_entries_vendor_date_idx").on(table.vendorId, table.entryDate)]);

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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("notifications_vendor_read_idx").on(table.vendorId, table.readAt, table.createdAt)]);

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
