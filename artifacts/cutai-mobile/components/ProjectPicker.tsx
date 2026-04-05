import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";

export interface Project {
  id: string;
  name: string;
  targetFormat: string;
  status: string;
  videoCount: number;
}

interface Props {
  projects: Project[];
  loading: boolean;
  selected: Project | null;
  onSelect: (p: Project) => void;
}

const FORMAT_LABELS: Record<string, string> = {
  instagram_reel: "Instagram",
  tiktok: "TikTok",
  youtube_short: "YouTube Short",
  youtube_long: "YouTube",
  wedding_highlight: "Wedding",
  ad_spot: "Ad",
  custom: "Custom",
};

export function ProjectPicker({ projects, loading, selected, onSelect }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const styles = StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 8,
    },
    triggerLabel: {
      flex: 1,
      fontSize: 14,
      fontFamily: "Inter_500Medium",
      color: selected ? colors.foreground : colors.mutedForeground,
    },
    overlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: insets.bottom + 24,
      maxHeight: "70%",
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      alignSelf: "center",
      marginTop: 12,
      marginBottom: 8,
    },
    sheetTitle: {
      fontSize: 15,
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 14,
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowName: {
      flex: 1,
      fontSize: 14,
      fontFamily: "Inter_500Medium",
      color: colors.foreground,
    },
    rowBadge: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      backgroundColor: colors.muted,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 4,
    },
    empty: {
      alignItems: "center",
      padding: 32,
      gap: 8,
    },
    emptyText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
  });

  return (
    <>
      <Pressable style={styles.trigger} onPress={() => setOpen(true)}>
        <Feather name="folder" size={16} color={colors.mutedForeground} />
        <Text style={styles.triggerLabel} numberOfLines={1}>
          {selected ? selected.name : "Select project…"}
        </Text>
        <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Choose Project</Text>
            {loading ? (
              <ActivityIndicator style={{ padding: 32 }} color={colors.accent} />
            ) : projects.length === 0 ? (
              <View style={styles.empty}>
                <Feather name="inbox" size={32} color={colors.mutedForeground} />
                <Text style={styles.emptyText}>No projects yet</Text>
              </View>
            ) : (
              <FlatList
                data={projects}
                keyExtractor={(p) => p.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => {
                      onSelect(item);
                      setOpen(false);
                    }}
                  >
                    <Feather
                      name="folder"
                      size={18}
                      color={selected?.id === item.id ? colors.accent : colors.mutedForeground}
                    />
                    <Text style={styles.rowName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.rowBadge}>
                      {FORMAT_LABELS[item.targetFormat] ?? item.targetFormat}
                    </Text>
                    {selected?.id === item.id && (
                      <Feather name="check" size={16} color={colors.accent} />
                    )}
                  </TouchableOpacity>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
