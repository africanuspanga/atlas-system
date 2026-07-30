import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import {
  SafeAreaView,
  type Edge,
} from "react-native-safe-area-context";

import { color, space } from "@/lib/theme";

/**
 * Page floor: white canvas + safe-area handling. Screens inside the tab bar
 * pass edges={["top"]} (the tab bar owns the bottom inset).
 */
export function Screen({
  children,
  edges = ["top"],
  padded = true,
  style,
}: {
  children: ReactNode;
  edges?: readonly Edge[];
  padded?: boolean;
  style?: ViewStyle;
}) {
  return (
    <SafeAreaView edges={edges} style={styles.root}>
      <View style={[styles.body, padded && styles.padded, style]}>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  body: { flex: 1 },
  padded: { paddingHorizontal: space(5) },
});
