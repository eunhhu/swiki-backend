import { createHash } from "crypto";

export function hashIpUa(ip: string | undefined, ua: string | undefined): string {
  const str = `${ip ?? "unknown"}|${ua ?? "unknown"}`;
  return createHash("sha256").update(str).digest("hex");
}
