import { ProtectedRoleRoute } from "../protected-role-route";

export default function VendorPage() {
  return <ProtectedRoleRoute role="vendor" />;
}
