export type CustomerCartLine = {
  inventoryId: number;
  vendorId: number;
  branchId: number;
  branchName: string;
  productId: number;
  businessName: string;
  productName: string;
  salePricePaise: number;
  gstPercent: number;
  availableQuantity: number;
  prescriptionRequired: boolean;
  quantity: number;
  refillReminderId?: number;
  homeDelivery: boolean;
  publicLocation: null | {
    label: string;
    address: string;
    latitude: string;
    longitude: string;
    pickupEnabled: boolean;
    serviceEnabled: boolean;
    serviceRadiusKm: number;
  };
};

export type CustomerCartGroup = {
  vendorId: number;
  branchId: number;
  branchName: string;
  businessName: string;
  lines: CustomerCartLine[];
  unitCount: number;
  estimatedSubtotalPaise: number;
  estimatedTaxPaise: number;
  requiresPrescription: boolean;
};

function boundedQuantity(value: number, availableQuantity: number) {
  const available = Math.max(1, Math.min(100, Math.trunc(availableQuantity)));
  return Math.max(1, Math.min(available, Number.isFinite(value) ? Math.trunc(value) : 1));
}

export function addCustomerCartLine(
  current: CustomerCartLine[],
  offer: Omit<CustomerCartLine, "quantity">,
  quantity: number,
) {
  const existing = current.find((line) => line.inventoryId === offer.inventoryId);
  const nextQuantity = boundedQuantity((existing?.quantity ?? 0) + quantity, offer.availableQuantity);
  if (existing) {
    return current.map((line) => line.inventoryId === offer.inventoryId
      ? { ...offer, quantity: nextQuantity }
      : line);
  }
  return [...current, { ...offer, quantity: boundedQuantity(quantity, offer.availableQuantity) }];
}

export function updateCustomerCartQuantity(current: CustomerCartLine[], inventoryId: number, quantity: number) {
  if (quantity <= 0) return current.filter((line) => line.inventoryId !== inventoryId);
  return current.map((line) => line.inventoryId === inventoryId
    ? { ...line, quantity: boundedQuantity(quantity, line.availableQuantity) }
    : line);
}

export function groupCustomerCart(current: CustomerCartLine[]): CustomerCartGroup[] {
  const groups = new Map<string, CustomerCartLine[]>();
  for (const line of current) {
    const key = `${line.vendorId}:${line.branchId}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.values()].map((lines) => ({
    vendorId: lines[0]?.vendorId ?? 0,
    branchId: lines[0]?.branchId ?? 0,
    branchName: lines[0]?.branchName ?? "Branch",
    businessName: lines[0]?.businessName ?? "Pharmacy",
    lines,
    unitCount: lines.reduce((total, line) => total + line.quantity, 0),
    estimatedSubtotalPaise: lines.reduce((total, line) => total + line.salePricePaise * line.quantity, 0),
    estimatedTaxPaise: lines.reduce((total, line) => total + Math.round(line.salePricePaise * line.quantity * line.gstPercent / 100), 0),
    requiresPrescription: lines.some((line) => line.prescriptionRequired),
  }));
}

export function customerCartCheckoutItems(group: CustomerCartGroup) {
  return group.lines.map((line) => ({ inventoryId: line.inventoryId, quantity: line.quantity }));
}
