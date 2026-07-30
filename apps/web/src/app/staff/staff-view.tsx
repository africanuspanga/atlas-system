"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { UserPlusIcon, CopyIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

const ROLE_KEYS = [
	"school_admin",
	"head_teacher",
	"academic_master",
	"bursar",
	"accountant",
	"cashier",
	"teacher",
	"class_teacher",
] as const;

interface Member {
	id: string;
	status: string;
	created_at: string;
	profiles: { full_name: string } | null;
	membership_roles: Array<{ roles: { name: string; key: string } | null }>;
}

interface Invitation {
	id: string;
	email: string;
	role_keys: string[];
	status: string;
	expires_at: string;
}

export function StaffView({ tenantId, lang }: { tenantId: string; lang: Lang }) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [members, setMembers] = useState<Member[]>([]);
	const [invitations, setInvitations] = useState<Invitation[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		const [staffRes, invRes] = await Promise.all([
			apiFetch("/api/v1/staff", { tenantId }),
			apiFetch("/api/v1/invitations", { tenantId }),
		]);
		if (staffRes.ok) {
			setMembers((await staffRes.json()).data);
		} else {
			const body = await staffRes.json().catch(() => null);
			setLoadError(apiErrorMessage(t, body, staffRes.status));
		}
		if (invRes.ok) {
			setInvitations((await invRes.json()).data);
		}
		setLoaded(true);
	}, [tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">{t("staff.title")}</h1>
				<InviteDialog lang={lang} onCreated={reload} tenantId={tenantId} />
			</div>
			{loadError && <p className="text-sm text-destructive">{loadError}</p>}

			{!loaded ? (
				<ListSkeleton rows={6} />
			) : (
			<Card className="shadow-none">
				<CardContent className="pt-4">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("students.name")}</TableHead>
								<TableHead>{t("staff.roles")}</TableHead>
								<TableHead>{t("staff.status")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{members.map((m) => (
								<TableRow key={m.id}>
									<TableCell>{m.profiles?.full_name || "—"}</TableCell>
									<TableCell className="flex gap-1">
										{m.membership_roles.map((r) =>
											r.roles ? (
												<Badge key={r.roles.key} variant="outline">
													{r.roles.name}
												</Badge>
											) : null,
										)}
									</TableCell>
									<TableCell>
										<Badge variant="outline">{m.status}</Badge>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
			)}

			{invitations.filter((i) => i.status === "pending").length > 0 && (
				<Card className="shadow-none">
					<CardHeader>
						<CardTitle className="text-base">{t("staff.pending")}</CardTitle>
					</CardHeader>
					<CardContent>
						<Table>
							<TableBody>
								{invitations
									.filter((i) => i.status === "pending")
									.map((i) => (
										<TableRow key={i.id}>
											<TableCell>{i.email}</TableCell>
											<TableCell>{i.role_keys.join(", ")}</TableCell>
											<TableCell className="text-muted-foreground text-xs">
												{t("staff.expires")} {new Date(i.expires_at).toLocaleDateString()}
											</TableCell>
										</TableRow>
									))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function InviteDialog({
	tenantId,
	lang,
	onCreated,
}: {
	tenantId: string;
	lang: Lang;
	onCreated: () => Promise<void>;
}) {
	const t = getDict(lang);
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [roles, setRoles] = useState<string[]>(["teacher"]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [inviteUrl, setInviteUrl] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	function toggleRole(key: string) {
		setRoles((r) => (r.includes(key) ? r.filter((k) => k !== key) : [...r, key]));
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/invitations", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ email, roleKeys: roles }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setInviteUrl(body.inviteUrl);
			await onCreated();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					setInviteUrl(null);
					setEmail("");
					setCopied(false);
				}
			}}
			open={open}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<UserPlusIcon /> {t("staff.invite")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("staff.invite")}</DialogTitle>
				</DialogHeader>
				{inviteUrl ? (
					<div className="flex flex-col gap-3">
						<p className="text-sm">{t("staff.inviteCreated")}</p>
						<div className="flex gap-2">
							<Input readOnly value={inviteUrl} />
							<Button
								aria-label={t("common.copy")}
								onClick={async () => {
									await navigator.clipboard.writeText(inviteUrl);
									setCopied(true);
								}}
								size="icon"
								variant="outline"
							>
								<CopyIcon />
							</Button>
						</div>
						{copied && <p className="text-xs text-muted-foreground">{t("common.copied")}</p>}
						<Button className="self-end" onClick={() => setOpen(false)} variant="outline">
							{t("common.close")}
						</Button>
					</div>
				) : (
					<form className="flex flex-col gap-3" onSubmit={submit}>
						<Input
							onChange={(e) => setEmail(e.target.value)}
							placeholder={t("staff.email")}
							required
							type="email"
							value={email}
						/>
						<div className="flex flex-wrap gap-2">
							{ROLE_KEYS.map((key) => (
								<Button
									key={key}
									onClick={() => toggleRole(key)}
									size="sm"
									type="button"
									variant={roles.includes(key) ? "default" : "outline"}
								>
									{t(`staff.role.${key}`)}
								</Button>
							))}
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
						<Button className="self-end" disabled={pending || roles.length === 0} type="submit">
							{pending ? t("common.loading") : t("staff.invite")}
						</Button>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
