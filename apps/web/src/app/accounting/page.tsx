import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import type { DictKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

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

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: accounts }, { data: lines }, { data: entries }] = await Promise.all([
		supabase.from("ledger_accounts").select("id, code, name, type").order("code"),
		supabase.from("journal_lines").select("account_id, debit, credit"),
		supabase
			.from("journal_entries")
			.select(
				"id, entry_number, entry_date, description, journal_lines(debit, credit, ledger_accounts(code, name))",
			)
			.order("created_at", { ascending: false })
			.limit(20),
	]);

	const totals = new Map<string, { debit: number; credit: number }>();
	for (const line of lines ?? []) {
		const bucket = totals.get(line.account_id) ?? { debit: 0, credit: 0 };
		bucket.debit += Number(line.debit);
		bucket.credit += Number(line.credit);
		totals.set(line.account_id, bucket);
	}

	const { t } = await getServerDict();

	const rows = (accounts ?? []).map((account) => {
		const sums = totals.get(account.id) ?? { debit: 0, credit: 0 };
		// asset/expense accounts carry debit balances; the rest credit balances
		const debitNormal = account.type === "asset" || account.type === "expense";
		const balance = debitNormal ? sums.debit - sums.credit : sums.credit - sums.debit;
		return { ...account, ...sums, balance };
	});
	const totalDebits = rows.reduce((sum, row) => sum + row.debit, 0);
	const totalCredits = rows.reduce((sum, row) => sum + row.credit, 0);

	return (
		<AppShell schoolName={tenant.name}>
			<div className="flex flex-col gap-4">
				<h1 className="text-xl font-semibold">{t("acct.title")}</h1>

				<Card className="shadow-none">
					<CardHeader>
						<CardTitle className="text-base">{t("acct.trialBalance")}</CardTitle>
					</CardHeader>
					<CardContent>
						{rows.length === 0 ? (
							<p className="py-6 text-center text-sm text-muted-foreground">
								{t("acct.empty")}
							</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("acct.account")}</TableHead>
										<TableHead>{t("acct.type")}</TableHead>
										<TableHead className="text-right">{t("acct.debit")}</TableHead>
										<TableHead className="text-right">{t("acct.credit")}</TableHead>
										<TableHead className="text-right">{t("finance.balance")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((row) => (
										<TableRow key={row.id}>
											<TableCell>
												<span className="font-mono text-xs">{row.code}</span> {row.name}
											</TableCell>
											<TableCell>
												<Badge variant="outline">
													{t(`acct.type.${row.type}` as DictKey)}
												</Badge>
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{fmt(row.debit)}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{fmt(row.credit)}
											</TableCell>
											<TableCell className="text-right font-medium tabular-nums">
												{fmt(row.balance)}
											</TableCell>
										</TableRow>
									))}
									<TableRow>
										<TableCell className="font-semibold" colSpan={2}>
											{t("finance.total")}
										</TableCell>
										<TableCell className="text-right font-semibold tabular-nums">
											{fmt(totalDebits)}
										</TableCell>
										<TableCell className="text-right font-semibold tabular-nums">
											{fmt(totalCredits)}
										</TableCell>
										<TableCell />
									</TableRow>
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>

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
