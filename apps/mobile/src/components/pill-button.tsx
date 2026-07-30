import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from "react-native";

import { color, font, radius, space } from "@/lib/theme";

type Variant = "primary" | "secondary" | "destructive-text";

/**
 * Pill CTA per design.md: 44px min height, fully rounded, pressed state
 * darkens toward #003ecc. `destructive-text` is text-only — loss red is
 * never a fill.
 */
export function PillButton({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  haptic = false,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  /** Light impact on press — reserve for primary confirms. */
  haptic?: boolean;
  icon?: ReactNode;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={() => {
        if (haptic) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" && {
          backgroundColor: isDisabled
            ? color.primaryDisabled
            : pressed
              ? color.primaryActive
              : color.primary,
        },
        variant === "secondary" && {
          backgroundColor: pressed ? color.hairline : color.surfaceStrong,
        },
        variant === "destructive-text" && {
          backgroundColor: pressed ? color.surfaceSoft : "transparent",
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "primary" ? color.onPrimary : color.ink}
          size="small"
        />
      ) : (
        <>
          {icon}
          <Text
            numberOfLines={1}
            style={[
              styles.label,
              variant === "primary" && { color: color.onPrimary },
              variant === "secondary" && { color: color.ink },
              variant === "destructive-text" && { color: color.loss },
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 44,
    borderRadius: radius.pill,
    paddingHorizontal: space(5),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(2),
  },
  label: {
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 20,
  },
});
