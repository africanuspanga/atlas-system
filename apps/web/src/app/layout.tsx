import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const interSans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "ATLAS",
    template: "%s · ATLAS",
  },
  description:
    "The operating system of a school. Fees, attendance, marks and parent messaging for Tanzanian schools.",
};

/**
 * Colours the mobile browser chrome to match the page it is framing. Two
 * entries rather than one because the product has a dark mode: a single light
 * theme-colour leaves a white bar above a near-black dashboard.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1d1d1f" },
  ],
  colorScheme: "light dark",
};

/**
 * Applies the saved theme BEFORE first paint. Doing this in a component would
 * flash the light theme on every load for anyone who chose dark, because React
 * only runs after the document has already been painted.
 *
 * Falls back to the operating system until someone picks a side explicitly.
 * Wrapped in try/catch: localStorage throws in some privacy modes, and a theme
 * preference is never worth breaking the page over.
 */
const THEME_INIT = `try{var t=localStorage.getItem("atlas-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${interSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
