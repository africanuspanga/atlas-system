"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MegaphoneIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

export interface AnnouncementRow {
	id: string;
	audienceType: string;
	sectionLabel: string | null;
	body: string;
	recipients: number;
	createdAt: string;
}

export interface OutboxStats {
	pending: number;
	sent: number;
	failed: number;
}

export interface SectionOption {
	id: string;
	label: string;
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CommunicationView({
	tenantId,
	announcements,
	outbox,
	sections,
	lang,
}: {
	tenantId: string;
	announcements: AnnouncementRow[];
	outbox: OutboxStats;
	sections: SectionOption[];
	lang: Lang;
}) {
	const t = getDict(lang);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("comm.title")}</h1>
				<div className="flex items-center gap-2">
					<Badge variant="outline">
						{t("comm.outbox")}: {outbox.pending} {t("comm.pending").toLowerCase()} ·{" "}
						{outbox.sent} {t("comm.sentStatus").toLowerCase()}
						{outbox.failed > 0 && ` · ${outbox.failed} ${t("comm.failed").toLowerCase()}`}
					</Badge>
					<ComposeDialog lang={lang} sections={sections} tenantId={tenantId} />
				</div>
			</div>

			<Card className="shadow-none">
				<CardContent className="pt-4">
					{announcements.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("comm.empty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("finance.date")}</TableHead>
									<TableHead>{t("comm.audience")}</TableHead>
									<TableHead>{t("comm.body")}</TableHead>
									<TableHead className="text-right">{t("comm.recipients")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{announcements.map((a) => (
									<TableRow key={a.id}>
										<TableCell className="whitespace-nowrap text-xs">
											{a.createdAt.slice(0, 10)}
										</TableCell>
										<TableCell>
											<Badge variant="outline">
												{a.audienceType === "all_guardians"
													? t("comm.allGuardians")
													: a.sectionLabel}
											</Badge>
										</TableCell>
										<TableCell className="max-w-md">
											<span className="line-clamp-2 text-sm">{a.body}</span>
										</TableCell>
										<TableCell className="text-right tabular-nums">{a.recipients}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function ComposeDialog({
	tenantId,
	sections,
	lang,
}: {
	tenantId: string;
	sections: SectionOption[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [audience, setAudience] = useState("all_guardians");
	const [sectionId, setSectionId] = useState("");
	const [body, setBody] = useState("");

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		setMessage(null);
		const response = await apiFetch("/api/v1/communication/announcements", {
			method: "POST",
			tenantId,
			body: JSON.stringify({
				audienceType: audience,
				classSectionId: audience === "class_section" ? sectionId : undefined,
				body,
			}),
		});
		setPending(false);
		if (!response.ok) {
			const responseBody = await response.json().catch(() => null);
			setError(responseBody?.message ?? responseBody?.code ?? `HTTP ${response.status}`);
			return;
		}
		const result = await response.json();
		setMessage(`${t("comm.queuedFor")} ${result.recipients} ${t("comm.recipients")}.`);
		setBody("");
		router.refresh();
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" />}>
				<MegaphoneIcon /> {t("comm.compose")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("comm.compose")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<div className="grid grid-cols-2 gap-2">
						<select
							className={selectClass}
							onChange={(e) => setAudience(e.target.value)}
							value={audience}
						>
							<option value="all_guardians">{t("comm.allGuardians")}</option>
							<option value="class_section">{t("students.class")}</option>
						</select>
						{audience === "class_section" && (
							<select
								className={selectClass}
								onChange={(e) => setSectionId(e.target.value)}
								required
								value={sectionId}
							>
								<option value="">{t("students.class")} —</option>
								{sections.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						)}
					</div>
					<textarea
						className="min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
						maxLength={480}
						minLength={3}
						placeholder={t("comm.body")}
						required
						value={body}
						onChange={(e) => setBody(e.target.value)}
					/>
					<p className="text-right text-xs text-muted-foreground">
						{body.length}/480 {t("comm.chars")}
					</p>
					{error && <p className="text-sm text-destructive">{error}</p>}
					{message && <p className="text-sm font-medium text-primary">{message}</p>}
					<div className="flex justify-end gap-2">
						<Button onClick={() => setOpen(false)} type="button" variant="outline">
							{t("common.close")}
						</Button>
						<Button disabled={pending || body.trim().length < 3} type="submit">
							{pending ? t("common.loading") : t("comm.send")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
