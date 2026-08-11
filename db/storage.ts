export function getR2(): R2Bucket {
  const bucket = (globalThis as typeof globalThis & { __URMED_R2__?: R2Bucket }).__URMED_R2__;
  if (!bucket) throw new Error("URMED secure document storage is unavailable");
  return bucket;
}
