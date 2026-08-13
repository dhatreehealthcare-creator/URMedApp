export const CANONICAL_DOSAGE_FORMS = [
  { id: 1, code: "TAB", slug: "tablet", name: "Tablet", status: "active", sortOrder: 10, legacyCategoryId: 1 },
  { id: 2, code: "CAP", slug: "capsule", name: "Capsule", status: "active", sortOrder: 20, legacyCategoryId: 2 },
  { id: 3, code: "INJ", slug: "injection", name: "Injection", status: "active", sortOrder: 30, legacyCategoryId: 3 },
  { id: 4, code: "OINT", slug: "ointment", name: "Ointment", status: "active", sortOrder: 40, legacyCategoryId: 4 },
  { id: 5, code: "CRM", slug: "cream", name: "Cream", status: "active", sortOrder: 50, legacyCategoryId: 5 },
  { id: 6, code: "AER", slug: "aerosol", name: "Aerosol", status: "active", sortOrder: 60, legacyCategoryId: 6 },
  { id: 7, code: "TDP", slug: "transdermal-patch", name: "Transdermal Patch", status: "active", sortOrder: 70, legacyCategoryId: 7 },
  { id: 8, code: "SYR", slug: "syrup", name: "Syrup", status: "active", sortOrder: 80, legacyCategoryId: 8 },
] as const;

export type CanonicalDosageForm = (typeof CANONICAL_DOSAGE_FORMS)[number];

export const LEGACY_CATEGORY_TO_DOSAGE_FORM = Object.freeze(Object.fromEntries(
  CANONICAL_DOSAGE_FORMS.map((form) => [form.legacyCategoryId, form.id]),
)) as Readonly<Record<number, number>>;
