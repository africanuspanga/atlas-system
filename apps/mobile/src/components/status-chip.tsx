import { StyleSheet, Text, View } from "react-native";

import { color, font, radius, space } from "@/lib/theme";

/**
 * Small uppercase pill badge — #eef0f3 fill, ink text. `tone` colors the TEXT
 * only (gain/loss are never background fills).
 */
export function StatusChip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "gain" | "loss" | "primary";
}) {
  return (
    <View style={styles.chip}>
      <Text
        numberOfLines={1}
        style={[
          styles.label,
          tone === "gain" && { color: color.gain },
          tone === "loss" && { color: color.loss },
          tone === "primary" && { color: color.primary },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: color.surfaceStrong,
    borderRadius: radius.pill,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1),
    alignSelf: "flex-start",
  },
  label: {
    fontFamily: font.semibold,
    fontSize: 12,
    lineHeight: 16,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    color: color.ink,
  },
});
