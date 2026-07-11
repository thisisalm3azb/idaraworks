import { redirect } from "next/navigation";
import { resolveLanding } from "./(auth)/actions";

/** Root: session → first workspace or onboarding; otherwise sign-in. */
export default async function Home() {
  redirect(await resolveLanding());
}
