import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MARKETING_ORIGIN } from "@/lib/hosts";
import { AppWindow } from "../../_components/shot";
import { ARTICLES, bySlug, type Block } from "../_articles";

export function generateStaticParams() {
	return ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({
	params,
}: {
	params: Promise<{ slug: string }>;
}): Promise<Metadata> {
	const { slug } = await params;
	const article = bySlug(slug);
	if (!article) return {};
	return {
		title: article.title,
		description: article.description,
		alternates: { canonical: `/blog/${article.slug}` },
		openGraph: {
			type: "article",
			title: article.title,
			description: article.description,
			publishedTime: article.published,
		},
	};
}

const fmtDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});

function BlockView({ block }: { block: Block }) {
	switch (block.type) {
		case "h2":
			return (
				<h2 className="ap-display-md" style={{ marginTop: "var(--ap-xl)" }}>
					{block.text}
				</h2>
			);
		case "p":
			return (
				<p className="ap-body" style={{ marginTop: "var(--ap-md)" }}>
					{block.text}
				</p>
			);
		case "list":
			return (
				<ul
					style={{
						marginTop: "var(--ap-md)",
						paddingLeft: "1.2em",
						display: "grid",
						gap: "var(--ap-xs)",
					}}
				>
					{block.items.map((item) => (
						<li className="ap-body" key={item}>
							{item}
						</li>
					))}
				</ul>
			);
		case "quote":
			return (
				<blockquote
					style={{
						marginTop: "var(--ap-xl)",
						marginInline: 0,
						paddingLeft: "var(--ap-lg)",
						borderLeft: "3px solid var(--ap-primary)",
					}}
				>
					<p className="ap-lead-airy">{block.text}</p>
				</blockquote>
			);
		case "image":
			return (
				<div style={{ marginTop: "var(--ap-xl)" }}>
					<AppWindow
						alt={block.alt}
						caption={block.caption}
						height={1200}
						needs={block.needs}
						src={block.src}
						width={1900}
					/>
				</div>
			);
	}
}

export default async function ArticlePage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	const { slug } = await params;
	const article = bySlug(slug);
	if (!article) notFound();

	const jsonLd = {
		"@context": "https://schema.org",
		"@type": "Article",
		headline: article.title,
		description: article.description,
		datePublished: article.published,
		inLanguage: "en-TZ",
		author: { "@type": "Organization", name: "ATLAS" },
		publisher: { "@type": "Organization", name: "ATLAS" },
		mainEntityOfPage: MARKETING_ORIGIN
			? `${MARKETING_ORIGIN}/blog/${article.slug}`
			: undefined,
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
			/>

			<article className="ap-tile ap-tile-light">
				<div className="ap-inner">
					<p className="ap-caption" style={{ color: "var(--ap-ink-48)" }}>
						<Link className="ap-link" href="/blog">
							Writing
						</Link>{" "}
						· {fmtDate(article.published)} · {article.readingMinutes} min read
					</p>

					<h1 className="ap-hero" style={{ marginTop: "var(--ap-sm)" }}>
						{article.title}
					</h1>
					<p
						className="ap-lead"
						style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
					>
						{article.description}
					</p>

					<div style={{ marginTop: "var(--ap-xxl)" }}>
						<AppWindow
							alt={article.hero.alt}
							caption={article.hero.caption}
							needs={article.hero.needs}
							priority
							src={article.hero.src}
						/>
					</div>

					<div style={{ marginTop: "var(--ap-xl)", maxWidth: 720 }}>
						{article.body.map((block, i) => (
							// Blocks are authored, ordered content — index is the stable id.
							<BlockView block={block} key={i} />
						))}
					</div>
				</div>
			</article>

			<section className="ap-tile ap-tile-parchment">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-display">See it with your own school&apos;s numbers.</h2>
					<div style={{ marginTop: "var(--ap-xl)" }}>
						<Link className="ap-btn" href="/anza">
							Book a demo
						</Link>
					</div>
				</div>
			</section>
		</>
	);
}
