import { requireLocalProfile, type LocalProfile } from "./auth-server.ts";

export async function requireAdminProfile(request: Request): Promise<LocalProfile> {
  return (await requireLocalProfile(request, ["admin"])).profile;
}
