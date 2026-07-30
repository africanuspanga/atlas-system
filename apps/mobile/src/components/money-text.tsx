import { StyleSheet, Text, type TextStyle } from "react-native";

import { color, fmtTZS, font } from "@/lib/theme";

/**
 * Every numerical amount renders in JetBrains Mono. Gain/loss are TEXT
 * colors only.
 */
export function MoneyText({
  amount,
  tone = "neutral",
  size = 16,
  style,
}: {
  amount: number;
  tone?: "neutral" | "gain" | "loss";
  size?: number;
  style?: TextStyle;
}) {
  return (
    <Text
      numberOfLines={1}
      style={[
        styles.money,
        { fontSize: size, lineHeight: Math.round(size * 1.4) },
        tone === "gain" && { color: color.gain },
        tone === "loss" && { color: color.loss },
        style,
      ]}
    >
      {fmtTZS(amount)}
    </Text>
  );
}

const styles = StyleSheet.create({
  money: {
    fontFamily: font.mono,
    color: color.ink,
  },
});
