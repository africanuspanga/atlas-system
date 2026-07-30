"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface TenantProfile {
	id: string;
	name: string;
	slug: string;
	status: string;
	region: string | null;
	district: string | null;
	address: string | null;
	phone: string | null;
	email: string | null;
	default_language: string;
	currency: string;
	timezone: string;
}

export interface TenantLanguageSettings {
	parent_language: string;
	report_language: string;
	invoice_language: string;
}

interface Member {
	id: string;
	status: string;
	profiles: { full_name: string } | null;
	membership_roles: Array<{ roles: { name: string; key: string } | null }>;
}

export function SettingsView({
	tenant,
	settings,
	lang,
}: {
	tenant: TenantProfile;
	settings: TenantLanguageSettings | null;
	lang: Lang;
}) {
	const t = getDict(lang);
	// RLS only lets a user read their own membership row, so the full member
	// list comes from the existing staff API endpoint.
	const [members, setMembers] = useState<Member[] | null>(null);

	const loadMembers = useCallback(async () => {
		const res = await apiFetch("/api/v1/staff", { tenantId: tenant.id });
		if (res.ok) {
			const body: { data: Member[] } = await res.json();
			setMembers(body.data);
		}
	}, [tenant.id]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void loadMembers();
	}, [loadMembers]);

	const langLabel = (value: string) => (value === "sw" ? t("settings.lang.sw") : t("settings.lang.en"));

	const profileRows: Array<{ label: string; value: string | null; mono?: boolean }> = [
		{ label: t("students.name"), value: tenant.name },
		{ label: t("students.status"), value: tenant.status },
		{ label: t("settings.region"), value: tenant.region },
		{ label: t("settings.district"), value: tenant.district },
		{ label: t("settings.address"), value: tenant.address },
		{ label: t("parents.phone"), value: tenant.phone, mono: true },
		{ label: t("staff.email"), value: tenant.email },
		{ label: t("settings.currency"), value: tenant.currency, mono: true },
		{ label: t("settings.timezone"), value: tenant.timezone },
	];

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">{t("settings.title")}</h1>
			<p className="text-sm text-muted-foreground">{t("settings.readOnly")}</p>

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("settings.profile")}</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col">
						{profileRows.map((row) => (
							<div
								className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0"
								key={row.label}
							>
								<span className="text-muted-foreground">{row.label}</span>
								<span className={row.mono ? "font-mono" : undefined}>{row.value || "—"}</span>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("settings.interfaceLanguage")}</CardTitle>
				</CardHeader>
				<CardContent className="flex items-center justify-between gap-4">
					<p className="text-sm text-muted-foreground">{t("settings.interfaceLanguageDesc")}</p>
					<LanguageSwitcher current={lang} />
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("settings.messagingLanguages")}</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col">
						{[
							{
								label: t("settings.parentLanguage"),
								value: settings?.parent_language ?? tenant.default_language,
							},
							{ label: t("settings.reportLanguage"), value: settings?.report_language ?? "en" },
							{ label: t("settings.invoiceLanguage"), value: settings?.invoice_language ?? "en" },
						].map((row) => (
							<div
								className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0"
								key={row.label}
							>
								<span className="text-muted-foreground">{row.label}</span>
								<span>{langLabel(row.value)}</span>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			{members !== null && (
				<Card className="shadow-none">
					<CardHeader>
						<CardTitle className="text-base">
							{t("settings.members")}{" "}
							<span className="font-mono text-sm font-normal text-muted-foreground">
								{members.length}
							</span>
						</CardTitle>
					</CardHeader>
					<CardContent>
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
		</div>
	);
}
