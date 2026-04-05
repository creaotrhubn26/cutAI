import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useUpload } from "@/context/UploadContext";

export function UploadBadge() {
  const colors = useColors();
  const { queue } = useUpload();
  const active = queue.filter((it) => it.status === "queued" || it.status === "uploading").length;

  if (active === 0) return null;

  return (
    <View style={[styles.badge, { backgroundColor: colors.accent }]}>
      <Text style={styles.text}>{active > 9 ? "9+" : active}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: "absolute",
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  text: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
