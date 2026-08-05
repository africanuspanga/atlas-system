import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { TrialBalanceCard } from "./accounting-view";

export const metadata = { title: "Accounting" };

function fmt(amount: number) {
	return amount === 0 ? "—" : amount.toLocaleString("en-US");
}

export default async function AccountingPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];
	const tenantId = tenant.id as string;

	// The trial balance comes from the ledger-reconciled report RPC via the
	// API (see TrialBalanceCard) — the recent journal is a simple RLS read.
	const { data: entries } = await supabase
		.from("journal_entries")
		.select(
			"id, entry_number, entry_date, description, journal_lines(debit, credit, ledger_accounts(code, name))",
		)
		.eq("tenant_id", tenantId)
		.order("created_at", { ascending: false })
		.limit(20);

	const { t } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<div className="flex flex-col gap-4">
				<h1 className="text-xl font-semibold">{t("acct.title")}</h1>

				<TrialBalanceCard tenantId={tenantId} />

				<Card className="shadow-none">
					<CardHeader>
						<CardTitle className="text-base">{t("acct.journal")}</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						{(entries ?? []).length === 0 ? (
							<p className="py-6 text-center text-sm text-muted-foreground">
								{t("acct.empty")}
							</p>
						) : (
							(entries ?? []).map((entry) => (
								<div className="rounded-md border p-3" key={entry.id}>
									<div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
										<span>
											<span className="font-mono text-xs">{entry.entry_number}</span>{" "}
											{entry.description}
										</span>
										<span className="text-muted-foreground">{entry.entry_date}</span>
									</div>
									<Table>
										<TableBody>
											{((entry.journal_lines ?? []) as unknown as Array<{
												debit: number;
												credit: number;
												ledger_accounts: { code: string; name: string } | null;
											}>).map((line, index) => (
												<TableRow key={`${entry.id}-${index}`}>
													<TableCell className={Number(line.credit) > 0 ? "pl-8" : ""}>
														<span className="font-mono text-xs">
															{line.ledger_accounts?.code}
														</span>{" "}
														{line.ledger_accounts?.name}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{fmt(Number(line.debit))}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{fmt(Number(line.credit))}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							))
						)}
					</CardContent>
				</Card>
			</div>
		</AppShell>
	);
}
