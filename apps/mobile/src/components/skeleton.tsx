import { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { color, space } from "@/lib/theme";

/** Subtle pulsing placeholder block. */
export function Skeleton({
  width,
  height = 16,
  radius = 8,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.45, { duration: 700 }), -1, true);
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        styles.block,
        { width: width ?? "100%", height, borderRadius: radius },
        animatedStyle,
        style,
      ]}
    />
  );
}

/** Stacked row skeletons for list screens — never show a blank white page. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={styles.row}>
          <Skeleton height={32} radius={16} width={32} />
          <View style={styles.rowText}>
            <Skeleton height={14} width="70%" />
            <Skeleton height={11} width="45%" />
          </View>
          <Skeleton height={14} width={64} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: color.surfaceStrong },
  list: { gap: space(4), paddingVertical: space(2) },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
  },
  rowText: { flex: 1, gap: space(1.5) },
});
