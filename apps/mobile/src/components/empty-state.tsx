import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { PillButton } from "@/components/pill-button";
import { color, font, space } from "@/lib/theme";

/** Friendly empty/error state with an optional retry action. */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      {icon ? <View style={styles.plate}>{icon}</View> : null}
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.desc}>{description}</Text> : null}
      {actionLabel && onAction ? (
        <PillButton
          onPress={onAction}
          style={styles.action}
          title={actionLabel}
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space(12),
    paddingHorizontal: space(6),
    gap: space(2),
  },
  plate: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space(2),
  },
  title: {
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 22,
    color: color.ink,
    textAlign: "center",
  },
  desc: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
    color: color.body,
    textAlign: "center",
  },
  action: { marginTop: space(3), alignSelf: "center", minWidth: 160 },
});
