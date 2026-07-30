import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { color, font, space } from "@/lib/theme";

/**
 * Data row per design.md: transparent row, hairline divider, optional 32px
 * circular icon plate left, right-aligned accessory (amount/chevron).
 */
export function ListRow({
  title,
  subtitle,
  icon,
  right,
  onPress,
  last = false,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
}) {
  const body = (
    <>
      {icon ? <View style={styles.plate}>{icon}</View> : null}
      <View style={styles.textCol}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </>
  );

  if (!onPress) {
    return <View style={[styles.row, !last && styles.divider]}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !last && styles.divider,
        pressed && styles.pressed,
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingVertical: space(3),
    minHeight: 56,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  pressed: { backgroundColor: color.surfaceSoft },
  plate: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: { flex: 1, gap: 2 },
  title: {
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 20,
    color: color.ink,
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 18,
    color: color.body,
  },
  right: { alignItems: "flex-end", justifyContent: "center" },
});
