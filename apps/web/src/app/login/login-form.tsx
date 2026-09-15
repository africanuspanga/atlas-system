"use client";

import { ArrowLeftIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { LogoIcon } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDict } from "@/i18n";
import { marketingHref } from "@/lib/hosts";
import { safeNext } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

/**
 * Public demo school ("Chief Sarwatt School") seeded by
 * apps/api/scripts/seed-demo.mjs. Deliberately visible — it is a demo.
 */
const DEMO_EMAIL = "demo@chiefsarwatt.sc.tz";
const DEMO_PASSWORD = "DemoAtlas2026!";

/** design.md: inputs are 48px tall with a 12px radius; buttons are pills. */
const FIELD = "h-12 rounded-lg px-4 text-base";

export function LoginForm() {
	const t = getDict();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [mode, setMode] = useState<Mode>("signin");
	const [fullName, setFullName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [revealed, setRevealed] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(
		searchParams.get("error") === "confirmation_failed"
			? t("login.confirmFailed")
			: null,
	);
	const [notice, setNotice] = useState<string | null>(null);

	async function signIn(signInEmail: string, signInPassword: string) {
		setError(null);
		setNotice(null);
		setPending(true);
		try {
			const supabase = createClient();
			const { error } = await supabase.auth.signInWithPassword({
				email: signInEmail,
				password: signInPassword,
			});
			if (error) {
				setError(error.message);
				return;
			}
			router.push(safeNext(searchParams.get("next")));
			router.refresh();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	function demoSignIn() {
		// Fill the form so the visitor sees the credentials, then sign in.
		setMode("signin");
		setEmail(DEMO_EMAIL);
		setPassword(DEMO_PASSWORD);
		void signIn(DEMO_EMAIL, DEMO_PASSWORD);
	}

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault();
		setError(null);
		setNotice(null);

		if (mode === "signin") {
			await signIn(email, password);
			return;
		}
		setPending(true);
		try {
			const supabase = createClient();

			const { data, error } = await supabase.auth.signUp({
				email,
				password,
				options: {
					data: { full_name: fullName },
					emailRedirectTo: `${window.location.origin}/auth/confirm`,
				},
			});
			if (error) {
				setError(error.message);
				return;
			}
			if (data.session) {
				// Email confirmation disabled — signed in immediately.
				router.push("/onboarding");
				router.refresh();
				return;
			}
			setNotice(t("login.accountCreated"));
			setMode("signin");
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="flex w-full max-w-[420px] flex-col">
			<div className="flex items-center gap-2 text-primary">
				<LogoIcon className="size-7" />
				<span className="text-xl font-semibold tracking-tight text-foreground">
					ATLAS
				</span>
			</div>

			<h1 className="mt-8 text-[32px] leading-[1.13] font-normal tracking-[-0.4px] text-foreground">
				{mode === "signin" ? t("login.signin") : t("login.createTitle")}
			</h1>
			<p className="mt-2 text-muted-foreground">
				{mode === "signin" ? t("login.signinDesc") : t("login.signupDesc")}
			</p>

			<form className="mt-8 flex flex-col gap-4" onSubmit={handleSubmit}>
				{mode === "signup" && (
					<div className="flex flex-col gap-1.5">
						<label className="text-sm font-medium" htmlFor="fullName">
							{t("login.fullName")}
						</label>
						<Input
							autoComplete="name"
							className={FIELD}
							id="fullName"
							onChange={(e) => setFullName(e.target.value)}
							placeholder="Asha Mtoro"
							required
							value={fullName}
						/>
					</div>
				)}

				<div className="flex flex-col gap-1.5">
					<label className="text-sm font-medium" htmlFor="email">
						{t("login.email")}
					</label>
					<Input
						autoComplete="email"
						className={FIELD}
						id="email"
						onChange={(e) => setEmail(e.target.value)}
						placeholder="you@school.ac.tz"
						required
						type="email"
						value={email}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label className="text-sm font-medium" htmlFor="password">
						{t("login.password")}
					</label>
					{/* Typing a password you cannot see, on a phone, is where sign-ins
					    are abandoned. The toggle is a 48px target, not an icon. */}
					<div className="relative">
						<Input
							autoComplete={
								mode === "signin" ? "current-password" : "new-password"
							}
							className={`${FIELD} pr-12`}
							id="password"
							minLength={8}
							onChange={(e) => setPassword(e.target.value)}
							required
							type={revealed ? "text" : "password"}
							value={password}
						/>
						<button
							aria-label={
								revealed ? t("login.hidePassword") : t("login.showPassword")
							}
							className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							onClick={() => setRevealed((v) => !v)}
							type="button"
						>
							{revealed ? (
								<EyeOffIcon className="size-5" />
							) : (
								<EyeIcon className="size-5" />
							)}
						</button>
					</div>
				</div>

				<p aria-live="polite" className="sr-only">
					{error ?? notice ?? ""}
				</p>
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				{notice && <p className="text-sm text-muted-foreground">{notice}</p>}

				<Button
					className="mt-2 h-12 w-full text-base font-semibold"
					disabled={pending}
					type="submit"
				>
					{pending
						? t("login.pleaseWait")
						: mode === "signin"
							? t("login.signin")
							: t("login.createAccount")}
				</Button>
			</form>

			<div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
				<span className="h-px flex-1 bg-border" />
				{t("login.demoDivider")}
				<span className="h-px flex-1 bg-border" />
			</div>

			<Button
				className="mt-6 h-12 w-full text-base"
				disabled={pending}
				onClick={demoSignIn}
				type="button"
				variant="outline"
			>
				{t("login.tryDemo")}
			</Button>
			<p className="mt-2 text-center text-xs text-muted-foreground">
				{t("login.demoHint")}
			</p>

			<button
				className="mt-8 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				onClick={() => {
					setMode(mode === "signin" ? "signup" : "signin");
					setError(null);
					setNotice(null);
				}}
				type="button"
			>
				{mode === "signin" ? t("login.new") : t("login.existing")}
			</button>

			{/* Crosses to the marketing host, so it must be a plain <a>. */}
			<a
				className="mt-10 inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
				href={marketingHref("/")}
			>
				<ArrowLeftIcon className="size-4" />
				{t("login.backToSite")}
			</a>
		</div>
	);
}
