import { cookies } from "next/headers";
import { DASH_VARIANT_COOKIE, DEFAULT_DASH_VARIANT, isDashVariant, type DashVariant } from "./dash-variant";

/** server component 讀目前後台版本（原型評選用；定案後移除）。 */
export async function getDashVariant(): Promise<DashVariant> {
  const jar = await cookies();
  const raw = jar.get(DASH_VARIANT_COOKIE)?.value;
  return isDashVariant(raw) ? raw : DEFAULT_DASH_VARIANT;
}
