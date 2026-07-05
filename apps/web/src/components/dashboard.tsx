"use client";

import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
	GraduationCapIcon,
	CalendarCheckIcon,
	WalletIcon,
	AlertCircleIcon,
} from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatChartAxisTick, formatChartTooltipDate } from "@/components/formater";
import { getDict, type Lang } from "@/i18n";

export interface DashboardData {
	students: number;
	sections: number;
	presentToday: number;
	attendanceRateToday: number | null;
	collectedNet: number;
	receiptCount: number;
	outstanding: number;
	unpaidInvoices: number;
	attendanceTrend: Array<{ date: string; rate: number }>;
	collectionsByChannel: Array<{ channel: string; amount: number }>;
	recentPayments: Array<{
		receipt: string;
		student: string;
		method: string;
		amount: number;
	}>;
}

const attendanceChartConfig = {
	rate: {
		label: "%",
		color: "var(--chart-1)",
	},
} satisfies ChartConfig;

const collectionsChartConfig = {
	amount: {
		label: "TZS",
		color: "var(--chart-2)",
	},
} satisfies ChartConfig;

function fmtTZS(amount: number) {
	return `${amount.toLocaleString("en-US")} TZS`;
}

export function Dashboard({ data, lang }: { data: DashboardData; lang: Lang }) {
	const t = getDict(lang);
	const gradientId = `attendance-grad-${useId().replace(/:/g, "")}`;

	const stats = [
		{
			title: t("dash.totalStudents"),
			value: data.students.toLocaleString("en-US"),
			hint: `${data.sections} ${t("dash.classes")}`,
			icon: GraduationCapIcon,
		},
		{
			title: t("dash.presentToday"),
			value: data.presentToday.toLocaleString("en-US"),
			hint:
				data.attendanceRateToday !== null
					? `${data.attendanceRateToday}% ${t("dash.attendanceRate")}`
					: t("dash.noRegisters"),
			icon: CalendarCheckIcon,
		},
		{
			title: t("dash.collected"),
			value: fmtTZS(data.collectedNet),
			hint: `${data.receiptCount} ${t("dash.receipts")}`,
			icon: WalletIcon,
		},
		{
			title: t("dash.outstanding"),
			value: fmtTZS(data.outstanding),
			hint: `${data.unpaidInvoices} ${t("dash.invoicesUnpaid")}`,
			icon: AlertCircleIcon,
		},
	];

	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{stats.map((stat) => (
				<Card className="shadow-none dark:ring-0" key={stat.title}>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="font-medium text-muted-foreground text-sm">
							{stat.title}
						</CardTitle>
						<stat.icon className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="font-semibold text-2xl tabular-nums">{stat.value}</div>
						<p className="text-muted-foreground text-xs">{stat.hint}</p>
					</CardContent>
				</Card>
			))}

			<Card className="shadow-none md:col-span-2 dark:ring-0">
				<CardHeader>
					<CardTitle>{t("dash.attendanceTrend")}</CardTitle>
					<CardDescription>{t("dash.attendanceTrendDesc")}</CardDescription>
				</CardHeader>
				<CardContent>
					{data.attendanceTrend.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("dash.noData")}
						</p>
					) : (
						<ChartContainer className="aspect-22/8 w-full" config={attendanceChartConfig}>
							<AreaChart
								accessibilityLayer
								data={data.attendanceTrend}
								margin={{ left: 4, right: 8, top: 8 }}
							>
								<defs>
									<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
										<stop offset="0%" stopColor="var(--color-rate)" stopOpacity={0.4} />
										<stop offset="100%" stopColor="var(--color-rate)" stopOpacity={0} />
									</linearGradient>
								</defs>
								<CartesianGrid className="stroke-border" vertical={false} />
								<XAxis
									axisLine={false}
									dataKey="date"
									interval="preserveStartEnd"
									minTickGap={28}
									tickFormatter={(value) => formatChartAxisTick(String(value), 30)}
									tickLine={false}
									tickMargin={8}
								/>
								<YAxis
									axisLine={false}
									domain={[0, 100]}
									tick={{ className: "tabular-nums" }}
									tickLine={false}
									tickMargin={8}
									width={36}
								/>
								<ChartTooltip
									content={
										<ChartTooltipContent
											indicator="line"
											labelFormatter={(_, payload) => {
												const row = payload?.[0]?.payload as { date?: string } | undefined;
												return row?.date ? formatChartTooltipDate(row.date, "long") : "";
											}}
										/>
									}
									cursor={false}
								/>
								<Area
									dataKey="rate"
									dot={false}
									fill={`url(#${gradientId})`}
									stroke="var(--color-rate)"
									strokeWidth={2}
									type="natural"
								/>
							</AreaChart>
						</ChartContainer>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none md:col-span-2 dark:ring-0">
				<CardHeader>
					<CardTitle>{t("dash.collections")}</CardTitle>
					<CardDescription>{t("dash.collectionsDesc")}</CardDescription>
				</CardHeader>
				<CardContent>
					{data.collectionsByChannel.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("dash.noData")}
						</p>
					) : (
						<ChartContainer className="aspect-22/8 w-full" config={collectionsChartConfig}>
							<BarChart
								accessibilityLayer
								data={data.collectionsByChannel}
								margin={{ left: 4, right: 8, top: 8 }}
							>
								<CartesianGrid className="stroke-border" vertical={false} />
								<XAxis axisLine={false} dataKey="channel" tickLine={false} tickMargin={8} />
								<YAxis
									axisLine={false}
									tick={{ className: "tabular-nums" }}
									tickLine={false}
									tickMargin={8}
									width={64}
								/>
								<ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
								<Bar dataKey="amount" fill="var(--color-amount)" radius={[4, 4, 0, 0]} />
							</BarChart>
						</ChartContainer>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none md:col-span-2 lg:col-span-4 dark:ring-0">
				<CardHeader>
					<CardTitle>{t("dash.recentPayments")}</CardTitle>
					<CardDescription>{t("dash.recentPaymentsDesc")}</CardDescription>
				</CardHeader>
				<CardContent>
					{data.recentPayments.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("dash.noData")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("finance.receipt")}</TableHead>
									<TableHead>{t("finance.student")}</TableHead>
									<TableHead>{t("finance.method")}</TableHead>
									<TableHead className="text-right">{t("finance.amount")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.recentPayments.map((payment) => (
									<TableRow key={payment.receipt}>
										<TableCell className="font-mono text-xs">{payment.receipt}</TableCell>
										<TableCell>{payment.student}</TableCell>
										<TableCell>
											<Badge variant="outline">{payment.method}</Badge>
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{payment.amount.toLocaleString("en-US")}
										</TableCell>
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
