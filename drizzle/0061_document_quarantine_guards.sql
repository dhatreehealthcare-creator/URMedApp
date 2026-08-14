-- P7-02: signature validation is not malware validation. New uploads remain
-- pending_scan until the scanner has returned clean; quarantined objects are
-- never active or downloadable. Legacy content_validated rows are retained as
-- an explicitly grandfathered clean state for compatibility.
CREATE TRIGGER IF NOT EXISTS stored_documents_malware_status_guard
BEFORE INSERT ON stored_documents
WHEN NEW.malware_status NOT IN ('pending','pending_scan','clean','quarantined','scan_failed','content_validated')
BEGIN
  SELECT RAISE(ABORT, 'stored_document_malware_status_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stored_documents_malware_status_update_guard
BEFORE UPDATE OF malware_status ON stored_documents
WHEN NEW.malware_status NOT IN ('pending','pending_scan','clean','quarantined','scan_failed','content_validated')
BEGIN
  SELECT RAISE(ABORT, 'stored_document_malware_status_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS stored_documents_activation_guard
BEFORE UPDATE OF status ON stored_documents
WHEN NEW.status = 'active' AND NEW.malware_status NOT IN ('clean','content_validated')
BEGIN
  SELECT RAISE(ABORT, 'stored_document_not_clean');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS offline_prescriptions_insert_guard;
--> statement-breakpoint
CREATE TRIGGER offline_prescriptions_insert_guard
BEFORE INSERT ON offline_prescriptions
WHEN NEW.status <> 'uploaded'
  OR length(trim(NEW.patient_name)) < 2 OR length(trim(NEW.patient_address)) < 5
  OR length(trim(NEW.prescriber_name)) < 2 OR length(trim(NEW.prescriber_address)) < 5
  OR date(NEW.prescribed_on) IS NULL OR date(NEW.prescribed_on) > date('now')
  OR NOT EXISTS (
    SELECT 1 FROM stored_documents document
    WHERE document.id = NEW.document_id AND document.purpose = 'offline_prescription'
      AND document.vendor_id = NEW.vendor_id AND document.owner_profile_id = NEW.captured_by_profile_id
      AND document.status = 'active' AND document.malware_status IN ('clean','content_validated')
  )
  OR (NEW.customer_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM account_profiles customer
    WHERE customer.id = NEW.customer_profile_id AND customer.role = 'customer'
      AND customer.status = 'active' AND customer.email_verified = 1 AND customer.phone_verified = 1
  ))
  OR NOT EXISTS (
    SELECT 1 FROM account_profiles actor
    WHERE actor.id = NEW.captured_by_profile_id AND actor.role = 'vendor' AND actor.status = 'active'
      AND actor.email_verified = 1 AND actor.phone_verified = 1
      AND (EXISTS (SELECT 1 FROM vendors owner WHERE owner.id = NEW.vendor_id AND owner.profile_id = actor.id)
        OR EXISTS (SELECT 1 FROM vendor_staff staff WHERE staff.vendor_id = NEW.vendor_id
          AND staff.profile_id = actor.id AND staff.status = 'active'))
  )
BEGIN
  SELECT RAISE(ABORT, 'offline_prescription_invalid');
END;
