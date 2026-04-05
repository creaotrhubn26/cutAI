import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useUpload } from "@/context/UploadContext";
import { UploadQueueItem } from "@/components/UploadQueueItem";

const STATUS_ORDER = { uploading: 0, queued: 1, error: 2, done: 3 };

export default function QueueScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { queue, removeItem, retryItem } = useUpload();
  const isWeb = Platform.OS === "web";
  const bottomPad = isWeb ? 34 : insets.bottom;

  const sorted = [...queue].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  );

  const active = queue.filter(
    (it) => it.status === "queued" || it.status === "uploading"
  ).length;

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    listContent: {
      paddingHorizontal: 20,
      paddingBottom: bottomPad + 24,
    },
    header: {
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    subtitle: {
      fontSize: 13,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      marginTop: 2,
    },
    empty: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      paddingBottom: 80,
    },
    emptyTitle: {
      fontSize: 16,
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
    },
    emptyText: {
      fontSize: 13,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      textAlign: "center",
      paddingHorizontal: 40,
    },
    clearBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
    },
    clearBtnLabel: {
      fontSize: 13,
      fontFamily: "Inter_500Medium",
      color: colors.mutedForeground,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionPad: {
      paddingTop: 16,
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.subtitle}>
            {active > 0
              ? `${active} item${active !== 1 ? "s" : ""} uploading…`
              : "All caught up"}
          </Text>
          {queue.some((it) => it.status === "done" || it.status === "error") && (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => {
                queue
                  .filter((it) => it.status === "done" || it.status === "error")
                  .forEach((it) => removeItem(it.id));
              }}
            >
              <Feather name="trash-2" size={14} color={colors.mutedForeground} />
              <Text style={styles.clearBtnLabel}>Clear done</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="upload-cloud" size={48} color={colors.mutedForeground} />
          <Text style={styles.emptyTitle}>No uploads yet</Text>
          <Text style={styles.emptyText}>
            Capture or select footage from the Capture tab to start uploading to your projects.
          </Text>
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(it) => it.id}
          contentContainerStyle={[styles.listContent, styles.sectionPad]}
          renderItem={({ item }) => (
            <UploadQueueItem
              item={item}
              onRemove={() => removeItem(item.id)}
              onRetry={() => retryItem(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}
