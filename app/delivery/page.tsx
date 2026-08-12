import { ProtectedRoleRoute } from "../protected-role-route";

export default function DeliveryPage() {
  return <ProtectedRoleRoute role="delivery" />;
}
