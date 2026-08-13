import { redirect } from "next/navigation";
import { VendorVerificationReturn } from "../../vendor-verification-return";

export default async function VendorVerificationReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const keys = Object.keys(params);
  if (keys.length) {
    const problem = keys.some((key) => key === "error" || key === "error_code" || key === "error_description");
    redirect(problem ? "/vendor/verification-return/problem" : "/vendor/verification-return");
  }
  return <VendorVerificationReturn />;
}
