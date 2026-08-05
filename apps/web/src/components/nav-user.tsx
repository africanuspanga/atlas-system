"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getDict } from "@/i18n";
import { UserIcon, LogOutIcon } from "lucide-react";

export function NavUser() {
	const t = getDict();
	const router = useRouter();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");

	useEffect(() => {
		const supabase = createClient();
		supabase.auth.getUser().then(({ data }) => {
			if (data.user) {
				setEmail(data.user.email ?? "");
				setName((data.user.user_metadata?.full_name as string) ?? "");
			}
		});
	}, []);

	async function signOut() {
		const supabase = createClient();
		await supabase.auth.signOut();
		router.push("/login");
		router.refresh();
	}

	const initial = (name || email || "?").charAt(0).toUpperCase();

	return (
		<DropdownMenu>
			{/*
			  Base UI's Trigger renders a real <button> by default. Passing
			  render={<Avatar/>} replaced it with a <span>, which drops native
			  button semantics — keyboard activation and the implicit role a
			  screen reader announces. Keep the button and nest the avatar.
			*/}
			<DropdownMenuTrigger
				aria-label={t("user.account")}
				className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<Avatar className="size-8">
					<AvatarFallback>{initial}</AvatarFallback>
				</Avatar>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				{/*
				  Plain markup, not a MenuItem wrapping a Label. DropdownMenuLabel
				  renders Base UI's GroupLabel, which throws "MenuGroupContext is
				  missing" unless it sits inside a Menu.Group — that crash is what
				  used to happen the moment this menu opened. Nothing here is
				  interactive, so it should never have been a menu part.
				*/}
				<div className="flex items-center gap-3 px-1.5 py-2">
					<Avatar className="size-10">
						<AvatarFallback>{initial}</AvatarFallback>
					</Avatar>
					<div className="min-w-0">
						<p className="truncate font-medium text-foreground text-sm">
							{name || t("user.account")}
						</p>
						<p className="truncate text-muted-foreground text-xs">{email}</p>
					</div>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="cursor-pointer"
						onClick={() => router.push("/settings")}
					>
						<UserIcon />
						{t("user.profile")}
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={signOut}
						variant="destructive"
					>
						<LogOutIcon />
						{t("user.logout")}
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
