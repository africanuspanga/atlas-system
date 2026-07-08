"use client";

import { useEffect, useRef, useState } from "react";
import {
	CheckIcon,
	SendIcon,
	ShieldCheckIcon,
	SparklesIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface ProposedAction {
	actionId: string;
	preview: {
		title: string;
		lines: Array<[string, string]>;
		warnings: string[];
	};
	expiresAt: string;
	/** UI lifecycle: undefined = awaiting decision. */
	outcome?: { status: string; result?: Record<string, unknown>; error?: string };
}

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	toolsUsed?: string[];
	actions?: ProposedAction[];
}

const SUGGESTIONS = [
	"How much did we collect today?",
	"Which students have the highest unpaid balances?",
	"Wanafunzi wangapi wapo shuleni?",
	"Who was absent today?",
];

export function AssistantView({ tenantId, lang }: { tenantId: string; lang: Lang }) {
	const t = getDict(lang);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [input, setInput] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const bottom = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottom.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	async function send(text: string) {
		const message = text.trim();
		if (!message || pending) return;
		setMessages((m) => [...m, { role: "user", content: message }]);
		setInput("");
		setPending(true);
		setError(null);
		try {
			const res = await apiFetch("/api/v1/ai/chat", {
				method: "POST",
				body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
				tenantId,
			});
			const body = (await res.json().catch(() => null)) as {
				conversationId?: string;
				reply?: string;
				toolsUsed?: string[];
				proposedActions?: ProposedAction[];
				code?: string;
			} | null;
			if (!res.ok || !body?.reply) {
				setError(body?.code ?? `HTTP ${res.status}`);
				return;
			}
			setConversationId(body.conversationId ?? null);
			setMessages((m) => [
				...m,
				{
					role: "assistant",
					content: body.reply!,
					toolsUsed: body.toolsUsed,
					actions: body.proposedActions,
				},
			]);
		} finally {
			setPending(false);
		}
	}

	async function decideAction(
		messageIndex: number,
		actionId: string,
		decision: "confirm" | "reject",
	) {
		const res = await apiFetch(`/api/v1/ai/actions/${actionId}/${decision}`, {
			method: "POST",
			tenantId,
		});
		const body = (await res.json().catch(() => null)) as {
			status?: string;
			result?: Record<string, unknown>;
			error?: string;
			code?: string;
		} | null;
		const outcome = res.ok
			? decision === "reject"
				? { status: "rejected" }
				: { status: body?.status ?? "failed", result: body?.result, error: body?.error }
			: { status: "failed", error: body?.code ?? `HTTP ${res.status}` };
		setMessages((m) =>
			m.map((msg, i) =>
				i === messageIndex
					? {
							...msg,
							actions: msg.actions?.map((a) =>
								a.actionId === actionId ? { ...a, outcome } : a,
							),
						}
					: msg,
			),
		);
	}

	return (
		<div className="flex h-[calc(100svh-4rem)] flex-col gap-3 p-4 md:p-6">
			<div>
				<h1 className="flex items-center gap-2 text-xl font-semibold">
					<SparklesIcon className="size-5" /> ATLAS Assistant
				</h1>
				<p className="text-sm text-muted-foreground">
					Answers come only from your school&apos;s ATLAS records, limited to what your role may
					see. Every data access is audited.
				</p>
			</div>

			<Card className="flex-1 overflow-hidden">
				<CardContent className="flex h-full flex-col gap-3 overflow-y-auto p-4">
					{messages.length === 0 && (
						<div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
							<p className="text-sm text-muted-foreground">
								Ask about attendance, fees, collections or students — in English or Kiswahili.
							</p>
							<div className="flex flex-wrap justify-center gap-2">
								{SUGGESTIONS.map((s) => (
									<Button key={s} variant="outline" size="sm" onClick={() => void send(s)}>
										{s}
									</Button>
								))}
							</div>
						</div>
					)}
					{messages.map((m, i) => (
						<div
							key={i}
							className={
								m.role === "user"
									? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
									: "mr-auto max-w-[85%] rounded-lg border bg-muted/40 px-3 py-2 text-sm"
							}
						>
							<div className="whitespace-pre-wrap">{m.content}</div>
							{m.toolsUsed && m.toolsUsed.length > 0 && (
								<div className="mt-2 flex flex-wrap gap-1">
									{m.toolsUsed.map((tool, j) => (
										<Badge key={j} variant="secondary" className="text-[10px]">
											<WrenchIcon className="mr-1 size-2.5" />
											{tool}
										</Badge>
									))}
								</div>
							)}
							{m.actions?.map((action) => (
								<div
									key={action.actionId}
									className="mt-3 rounded-md border bg-background p-3 text-foreground"
								>
									<div className="flex items-center gap-1.5 text-sm font-semibold">
										<ShieldCheckIcon className="size-4" />
										{action.preview.title}
									</div>
									<dl className="mt-2 space-y-0.5 text-xs">
										{action.preview.lines.map(([label, value], k) => (
											<div key={k} className="flex gap-2">
												<dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
												<dd>{value}</dd>
											</div>
										))}
									</dl>
									{action.preview.warnings.map((w, k) => (
										<p key={k} className="mt-1.5 text-xs text-amber-600">
											⚠ {w}
										</p>
									))}
									{!action.outcome ? (
										<div className="mt-2.5 flex gap-2">
											<Button
												size="sm"
												onClick={() => void decideAction(i, action.actionId, "confirm")}
											>
												<CheckIcon className="mr-1 size-3.5" /> Confirm
											</Button>
											<Button
												size="sm"
												variant="outline"
												onClick={() => void decideAction(i, action.actionId, "reject")}
											>
												<XIcon className="mr-1 size-3.5" /> Reject
											</Button>
										</div>
									) : (
										<div className="mt-2.5 text-xs">
											{action.outcome.status === "executed" && (
												<Badge>
													Done
													{action.outcome.result?.receiptNumber
														? ` — receipt ${String(action.outcome.result.receiptNumber)}`
														: action.outcome.result?.invoiceNumber
															? ` — invoice ${String(action.outcome.result.invoiceNumber)}`
															: (action.outcome.result?.recipients ??
																		action.outcome.result?.queued) !== undefined
																? ` — ${String(action.outcome.result.recipients ?? action.outcome.result.queued)} queued`
																: ""}
												</Badge>
											)}
											{action.outcome.status === "rejected" && (
												<Badge variant="outline">Rejected — nothing was changed</Badge>
											)}
											{action.outcome.status === "failed" && (
												<Badge variant="destructive">
													Failed{action.outcome.error ? `: ${action.outcome.error}` : ""}
												</Badge>
											)}
										</div>
									)}
								</div>
							))}
						</div>
					))}
					{pending && (
						<div className="mr-auto rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
							{t("common.loading")}
						</div>
					)}
					<div ref={bottom} />
				</CardContent>
			</Card>

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}

			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void send(input);
				}}
			>
				<Input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder="Ask about your school's data…"
					maxLength={2000}
					disabled={pending}
				/>
				<Button type="submit" disabled={pending || input.trim().length === 0} aria-label="Send">
					<SendIcon className="size-4" />
				</Button>
			</form>
		</div>
	);
}
