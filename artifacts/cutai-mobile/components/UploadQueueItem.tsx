import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import type { UploadItem } from "@/context/UploadContext";

interface Props {
  item: UploadItem;
  onRemove: () => void;
  onRetry: () => void;
}

const STATUS_ICON: Record<UploadItem["status"], string> = {
  queued: "clock",
  uploading: "upload-cloud",
  done: "check-circle",
  error: "alert-circle",
};

export function UploadQueueItem({ item, onRemove, onRetry }: Props) {
  const colors = useColors();

  const iconColor =
    item.status === "done"
      ? "#22c55e"
      : item.status === "error"
      ? colors.destructive
      : item.status === "uploading"
      ? colors.accent
      : colors.mutedForeground;

  const styles = StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      marginBottom: 8,
      padding: 12,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    info: {
      flex: 1,
      gap: 3,
    },
    filename: {
      fontSize: 13,
      fontFamily: "Inter_500Medium",
      color: colors.foreground,
    },
    meta: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
    },
    error: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: colors.destructive,
    },
    progressBar: {
      height: 3,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginTop: 4,
      overflow: "hidden",
    },
    progressFill: {
      height: "100%",
      borderRadius: 2,
      backgroundColor: colors.accent,
    },
    actions: {
      flexDirection: "row",
      gap: 6,
    },
  });

  return (
    <View style={styles.row}>
      <Feather name={STATUS_ICON[item.status] as any} size={20} color={iconColor} />
      <View style={styles.info}>
        <Text style={styles.filename} numberOfLines={1}>
          {item.filename}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {item.projectName}
        </Text>
        {item.status === "uploading" && (
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${item.progress}%` }]} />
          </View>
        )}
        {item.status === "error" && item.errorMessage && (
          <Text style={styles.error} numberOfLines={2}>
            {item.errorMessage}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        {item.status === "error" && (
          <TouchableOpacity onPress={onRetry} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Feather name="refresh-cw" size={16} color={colors.accent} />
          </TouchableOpacity>
        )}
        {(item.status === "done" || item.status === "error") && (
          <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Feather name="x" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
