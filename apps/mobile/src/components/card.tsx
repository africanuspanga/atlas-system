import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { color, radius, space } from "@/lib/theme";

/** White card, 24px radius, 1px hairline — the only container treatment. */
export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.canvas,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    padding: space(5),
  },
});
