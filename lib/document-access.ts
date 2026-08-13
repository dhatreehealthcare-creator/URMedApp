import type { LocalProfile } from "./auth-server.ts";
import { requireVendorOnboardingAccess, requireVendorPermission } from "./vendor-access.ts";

export type StoredDocumentAccessRow = {
  id: number;
  ownerProfileId: number | null;
  vendorId: number | null;
  purpose: string;
};

async function linkedPrescriptionAccess(
  request: Request,
  profile: LocalProfile,
  document: StoredDocumentAccessRow,
  database: D1Database,
) {
  if (profile.role === "customer") {
    // The customer must be able to inspect a just-uploaded prescription before
    // the separate metadata submission links it to a prescriptions row.
    return document.ownerProfileId === profile.id;
  }
  if (profile.role !== "vendor") return false;
  const { vendorId } = await requireVendorPermission(request, "prescription.review");
  if (document.vendorId !== vendorId) return false;
  return Boolean(await database.prepare(`
    SELECT 1 FROM prescriptions
    WHERE document_id = ? AND vendor_id = ? LIMIT 1
  `).bind(document.id, vendorId).first());
}

async function complianceDocumentAccess(
  request: Request,
  profile: LocalProfile,
  document: StoredDocumentAccessRow,
) {
  if (profile.role !== "vendor") return false;
  const { profile: owner, vendorId } = await requireVendorOnboardingAccess(request);
  return owner.id === profile.id && document.ownerProfileId === profile.id && document.vendorId === vendorId;
}

async function offlinePrescriptionAccess(
  request: Request,
  profile: LocalProfile,
  document: StoredDocumentAccessRow,
  database: D1Database,
) {
  if (profile.role !== "vendor" || !document.vendorId || profile.vendorId !== document.vendorId) return false;
  const capture = await database.prepare(`SELECT captured_by_profile_id AS capturedByProfileId
    FROM offline_prescriptions WHERE document_id = ? AND vendor_id = ? LIMIT 1`)
    .bind(document.id, document.vendorId).first<{ capturedByProfileId: number }>();
  if (!capture) {
    const { vendorId } = await requireVendorPermission(request, "sale.write");
    return vendorId === document.vendorId && document.ownerProfileId === profile.id;
  }
  if (capture.capturedByProfileId === profile.id) {
    const { vendorId } = await requireVendorPermission(request, "sale.write");
    return vendorId === document.vendorId;
  }
  const { vendorId } = await requireVendorPermission(request, "prescription.review");
  return vendorId === document.vendorId;
}

async function deliveryProofAccess(
  request: Request,
  profile: LocalProfile,
  document: StoredDocumentAccessRow,
  database: D1Database,
) {
  if (profile.role === "customer") {
    return Boolean(await database.prepare(`
      SELECT 1 FROM delivery_assignments assignment
      JOIN orders current_order ON current_order.id = assignment.order_id
      WHERE assignment.proof_document_id = ? AND current_order.customer_profile_id = ? LIMIT 1
    `).bind(document.id, profile.id).first());
  }
  if (profile.role === "delivery") {
    return Boolean(await database.prepare(`
      SELECT 1 FROM delivery_assignments assignment
      JOIN delivery_agents agent ON agent.id = assignment.agent_id
      WHERE assignment.proof_document_id = ? AND agent.profile_id = ? LIMIT 1
    `).bind(document.id, profile.id).first());
  }
  if (profile.role !== "vendor") return false;
  const { vendorId } = await requireVendorPermission(request, "sale.write");
  return Boolean(await database.prepare(`
    SELECT 1 FROM delivery_assignments assignment
    JOIN orders current_order ON current_order.id = assignment.order_id
    WHERE assignment.proof_document_id = ? AND current_order.vendor_id = ? LIMIT 1
  `).bind(document.id, vendorId).first());
}

export async function canDownloadStoredDocument(input: {
  request: Request;
  profile: LocalProfile;
  document: StoredDocumentAccessRow;
  database: D1Database;
}) {
  const { request, profile, document, database } = input;
  if (profile.role === "admin") return true;
  if (document.purpose === "prescription") {
    return linkedPrescriptionAccess(request, profile, document, database);
  }
  if (document.purpose === "offline_prescription") {
    return offlinePrescriptionAccess(request, profile, document, database);
  }
  if (["drug_licence", "pharmacist_registration"].includes(document.purpose)) {
    return complianceDocumentAccess(request, profile, document);
  }
  if (document.purpose === "delivery_proof") {
    return deliveryProofAccess(request, profile, document, database);
  }
  return false;
}
