/**
 * ATLAS design tokens for native screens — derived from /design.md.
 * Single accent (Atlas Blue) used scarcely; pill buttons; 24px cards;
 * financial gain/loss are TEXT colors only, never fills.
 */
export const color = {
  primary: "#0052ff",
  primaryActive: "#003ecc",
  primaryDisabled: "#a8b8cc",
  accentYellow: "#f4b000", // illustrative only — never an action color
  canvas: "#ffffff",
  surfaceSoft: "#f7f7f7",
  surfaceStrong: "#eef0f3",
  surfaceDark: "#0a0b0d",
  surfaceDarkElevated: "#16181c",
  hairline: "#dee1e6",
  hairlineSoft: "#eef0f3",
  ink: "#0a0b0d",
  body: "#5b616e",
  muted: "#7c828a",
  mutedSoft: "#a8acb3",
  onPrimary: "#ffffff",
  gain: "#05b169", // text only
  loss: "#cf202f", // text only
} as const;

export const radius = {
  card: 24,
  input: 12,
  pill: 999,
} as const;

export const space = (n: number) => n * 4;

/** Font families as registered by useFonts in the root layout. */
export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  mono: "JetBrainsMono_500Medium", // numerals: money, counts, admission numbers
} as const;

export const fmtTZS = (n: number) =>
  `TZS ${Math.round(n).toLocaleString("en-US")}`;
