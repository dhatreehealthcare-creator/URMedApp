import { prepareAuditEventStatement } from "./audit.ts";

export class CategoryGovernanceError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "CategoryGovernanceError";
    this.status = status;
  }
}

export type SaveCategoryInput = {
  db: D1Database;
  id?: number;
  name: string;
  status: "active" | "inactive";
  actorProfileId: number;
  requestId?: string;
};

export async function saveProductCategory(input: SaveCategoryInput) {
  const requestedId = Number(input.id ?? 0);
  let id = requestedId;
  let before: { id: number; name: string; status: string } | null = null;
  if (requestedId) {
    before = await input.db.prepare("SELECT id,name,status FROM categories WHERE id=?")
      .bind(requestedId).first<{ id: number; name: string; status: string }>();
    if (!before) throw new CategoryGovernanceError("Category was not found", 404);
  } else {
    const next = await input.db.prepare("SELECT COALESCE(MAX(id),0)+1 AS id FROM categories").first<{ id: number }>();
    id = Number(next?.id);
    if (!Number.isInteger(id) || id < 1) throw new CategoryGovernanceError("Category identifier could not be allocated");
  }
  const mutation = requestedId
    ? input.db.prepare(`UPDATE categories SET name=?,status=? WHERE id=? AND NOT EXISTS
        (SELECT 1 FROM categories candidate WHERE candidate.id<>? AND lower(trim(candidate.name))=lower(trim(?)))`)
      .bind(input.name, input.status, id, id, input.name)
    : input.db.prepare(`INSERT INTO categories (id,name,status) SELECT ?,?,? WHERE NOT EXISTS
        (SELECT 1 FROM categories candidate WHERE lower(trim(candidate.name))=lower(trim(?)))`)
      .bind(id, input.name, input.status, input.name);
  const audit = await prepareAuditEventStatement({
    actorProfileId: input.actorProfileId,
    action: requestedId ? "category.updated" : "category.created",
    entityType: "category",
    entityId: id,
    before,
    after: { name: input.name, status: input.status },
    requestId: input.requestId ?? "",
  }, input.db, { whenPreviousStatementChanged: true });
  const results = await input.db.batch([mutation, audit]);
  if (!Number(results[0]?.meta.changes ?? 0)) {
    throw new CategoryGovernanceError("Another category already uses this name");
  }
  if (Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new CategoryGovernanceError("Category audit evidence could not be recorded", 500);
  }
  return { id, created: !requestedId };
}
