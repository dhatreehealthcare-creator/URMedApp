import { ProtectedRoleRoute } from "../protected-role-route";

export default function CustomerPage() {
  return <ProtectedRoleRoute role="customer" />;
}
