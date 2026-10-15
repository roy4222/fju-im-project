import { redirect } from "next/navigation";

/** v2：忘記密碼改在登入卡片內切換，舊網址導到同一個畫面。 */
export default function ForgotPasswordPage() {
  redirect("/login?mode=forgot");
}
