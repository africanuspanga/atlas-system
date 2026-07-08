"use client";

import { useEffect, useRef, useState } from "react";
import { SendIcon, SparklesIcon, WrenchIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	toolsUsed?: string[];
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
				code?: string;
			} | null;
			if (!res.ok || !body?.reply) {
				setError(body?.code ?? `HTTP ${res.status}`);
				return;
			}
			setConversationId(body.conversationId ?? null);
			setMessages((m) => [
				...m,
				{ role: "assistant", content: body.reply!, toolsUsed: body.toolsUsed },
			]);
		} finally {
			setPending(false);
		}
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
