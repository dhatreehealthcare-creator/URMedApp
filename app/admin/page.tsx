import { ProtectedRoleRoute } from "../protected-role-route";

export default function AdminPage() {
  return <ProtectedRoleRoute role="admin" />;
}
