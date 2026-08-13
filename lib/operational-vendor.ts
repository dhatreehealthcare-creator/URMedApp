/**
 * Canonical customer-facing pharmacy eligibility rule.
 *
 * This deliberately does not replace owner onboarding access. It is for public
 * discovery and customer transactions, where an approval/compliance snapshot
 * is insufficient once a licence or pharmacist registration expires.
 */
export function currentOperationalVendorPredicate(alias: string, asOfDate?: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error("A safe SQL vendor alias is required");
  }
  if (asOfDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error("A safe operational-vendor date is required");
  }
  const currentDate = asOfDate === undefined ? "date('now')" : `date('${asOfDate}')`;
  return `
    ${alias}.registration_status = 'submitted'
    AND ${alias}.approval_status = 'approved'
    AND ${alias}.compliance_status = 'verified'
    AND ${alias}.suspended_at IS NULL
    AND EXISTS (
      SELECT 1 FROM vendor_licences current_licence
      WHERE current_licence.vendor_id = ${alias}.id
        AND current_licence.verification_status = 'verified'
        AND current_licence.suspended_at IS NULL
        AND date(current_licence.valid_from) <= ${currentDate}
        AND date(current_licence.valid_until) >= ${currentDate}
    )
    AND EXISTS (
      SELECT 1 FROM pharmacists current_pharmacist
      WHERE current_pharmacist.vendor_id = ${alias}.id
        AND current_pharmacist.verification_status = 'verified'
        AND current_pharmacist.active = 1
        AND (current_pharmacist.valid_from IS NULL OR date(current_pharmacist.valid_from) <= ${currentDate})
        AND (current_pharmacist.valid_until IS NULL OR date(current_pharmacist.valid_until) >= ${currentDate})
    )
  `;
}

export function currentOperationalVendorExists(
  vendorIdExpression: string,
  alias = "operational_vendor",
) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(vendorIdExpression)) {
    throw new Error("A safe SQL vendor identifier is required");
  }
  return `EXISTS (
    SELECT 1 FROM vendors ${alias}
    WHERE ${alias}.id = ${vendorIdExpression}
      AND ${currentOperationalVendorPredicate(alias)}
  )`;
}
