import { authenticatedFetch } from "./marketplace-client";

function filenameFrom(response: Response, fallback: string) {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

async function invoiceBlob(endpoint: string, format: "pdf" | "html") {
  const response = await authenticatedFetch(`${endpoint}?format=${format}`, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "The GST invoice is unavailable");
  }
  return { blob: await response.blob(), filename: filenameFrom(response, `URMED-GST-invoice.${format}`) };
}

export async function downloadInvoice(endpoint: string) {
  const { blob, filename } = await invoiceBlob(endpoint, "pdf");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function printInvoice(endpoint: string) {
  const { blob } = await invoiceBlob(endpoint, "html");
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) {
    URL.revokeObjectURL(url);
    throw new Error("Allow pop-ups to open the printable GST invoice");
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
