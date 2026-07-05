"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

type Mode = "signin" | "signup";

/**
 * Public demo school ("Chief Sarwatt School") seeded by
 * apps/api/scripts/seed-demo.mjs. Deliberately visible — it is a demo.
 */
const DEMO_EMAIL = "demo@chiefsarwatt.sc.tz";
const DEMO_PASSWORD = "DemoAtlas2026!";

export function LoginForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [mode, setMode] = useState<Mode>("signin");
	const [fullName, setFullName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(
		searchParams.get("error") === "confirmation_failed"
			? "Email confirmation failed or the link expired. Please try again."
			: null,
	);
	const [notice, setNotice] = useState<string | null>(null);

	async function signIn(signInEmail: string, signInPassword: string) {
		setError(null);
		setNotice(null);
		setPending(true);
		const supabase = createClient();
		const { error } = await supabase.auth.signInWithPassword({
			email: signInEmail,
			password: signInPassword,
		});
		setPending(false);
		if (error) {
			setError(error.message);
			return;
		}
		const next = searchParams.get("next");
		router.push(next?.startsWith("/") ? next : "/");
		router.refresh();
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
		const supabase = createClient();

		const { data, error } = await supabase.auth.signUp({
			email,
			password,
			options: {
				data: { full_name: fullName },
				emailRedirectTo: `${window.location.origin}/auth/confirm`,
			},
		});
		setPending(false);
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
		setNotice("Account created. Check your email to confirm your address, then sign in.");
		setMode("signin");
	}

	return (
		<Card className="w-full max-w-sm shadow-none">
			<CardHeader>
				<CardTitle>{mode === "signin" ? "Sign in" : "Create your account"}</CardTitle>
				<CardDescription>
					{mode === "signin"
						? "Welcome back. Enter your details to continue."
						: "Start by creating the account that will own your school."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form className="flex flex-col gap-4" onSubmit={handleSubmit}>
					{mode === "signup" && (
						<div className="flex flex-col gap-1.5">
							<label className="text-sm font-medium" htmlFor="fullName">
								Full name
							</label>
							<Input
								id="fullName"
								required
								value={fullName}
								onChange={(e) => setFullName(e.target.value)}
								placeholder="Asha Mtoro"
							/>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<label className="text-sm font-medium" htmlFor="email">
							Email
						</label>
						<Input
							id="email"
							type="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="you@school.ac.tz"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<label className="text-sm font-medium" htmlFor="password">
							Password
						</label>
						<Input
							id="password"
							type="password"
							required
							minLength={8}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					{notice && <p className="text-sm text-muted-foreground">{notice}</p>}
					<Button disabled={pending} type="submit">
						{pending ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
					</Button>
				</form>
				<div className="mt-4 flex flex-col gap-3">
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						<span className="h-px flex-1 bg-border" />
						demo
						<span className="h-px flex-1 bg-border" />
					</div>
					<Button
						disabled={pending}
						onClick={demoSignIn}
						type="button"
						variant="outline"
					>
						Try the demo — Chief Sarwatt School
					</Button>
					<p className="text-center text-xs text-muted-foreground">
						Jaribu mfumo na shule ya mfano yenye taarifa kamili. Credentials fill in
						automatically.
					</p>
					<button
						className="text-sm text-muted-foreground underline-offset-4 hover:underline"
						onClick={() => {
							setMode(mode === "signin" ? "signup" : "signin");
							setError(null);
							setNotice(null);
						}}
						type="button"
					>
						{mode === "signin"
							? "New school? Create an account"
							: "Already have an account? Sign in"}
					</button>
				</div>
			</CardContent>
		</Card>
	);
}
