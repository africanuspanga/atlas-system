import { Suspense } from "react";
import { LoginForm } from "./login-form";
import { LogoIcon } from "@/components/logo";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-4">
			<div className="flex items-center gap-2 text-primary">
				<LogoIcon className="size-7" />
				<span className="text-2xl font-semibold tracking-tight text-foreground">ATLAS</span>
			</div>
			<Suspense>
				<LoginForm />
			</Suspense>
		</div>
	);
}
