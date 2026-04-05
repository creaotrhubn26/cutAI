import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useUpload } from "@/context/UploadContext";
import { ProjectPicker, type Project } from "@/components/ProjectPicker";
import { UploadBadge } from "@/components/UploadBadge";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "/api";

function useFetchProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/projects`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setProjects(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { projects, loading, error, reload: load };
}

const FORMAT_ICON: Record<string, string> = {
  instagram_reel: "instagram",
  tiktok: "video",
  youtube_short: "youtube",
  youtube_long: "youtube",
  wedding_highlight: "heart",
  ad_spot: "zap",
  custom: "edit-3",
};

const FORMAT_LABELS: Record<string, string> = {
  instagram_reel: "Instagram Reel",
  tiktok: "TikTok",
  youtube_short: "YouTube Short",
  youtube_long: "YouTube Long",
  wedding_highlight: "Wedding",
  ad_spot: "Ad Spot",
  custom: "Custom",
};

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { enqueue } = useUpload();
  const { projects, loading, error, reload } = useFetchProjects();

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [picking, setPicking] = useState(false);

  const isWeb = Platform.OS === "web";
  const topPad = isWeb ? 67 : insets.top;
  const bottomPad = isWeb ? 34 : insets.bottom;

  async function pickMedia(source: "camera" | "library") {
    if (!selectedProject) return;
    setPicking(true);
    try {
      let result: ImagePicker.ImagePickerResult;
      if (source === "camera") {
        result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["videos"],
          allowsEditing: false,
          quality: 1,
          videoMaxDuration: 300,
        });
      } else {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["videos"],
          allowsMultipleSelection: true,
          quality: 1,
        });
      }
      if (result.canceled) return;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const assets = result.assets ?? [];
      for (const asset of assets) {
        const filename = asset.fileName ?? `video_${Date.now()}.mp4`;
        enqueue({
          localUri: asset.uri,
          filename,
          projectId: selectedProject.id,
          projectName: selectedProject.name,
        });
      }

      router.push("/(tabs)/queue");
    } finally {
      setPicking(false);
    }
  }

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      paddingTop: topPad + 8,
      paddingHorizontal: 20,
      paddingBottom: 4,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    logoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    logoBox: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    logoText: {
      fontSize: 18,
      fontFamily: "Inter_700Bold",
      color: colors.foreground,
      letterSpacing: -0.5,
    },
    logoCut: {
      fontSize: 18,
      fontFamily: "Inter_700Bold",
      color: colors.accent,
    },
    queueBtn: {
      position: "relative",
    },
    content: {
      flex: 1,
      paddingHorizontal: 20,
    },
    section: {
      marginTop: 28,
    },
    sectionLabel: {
      fontSize: 11,
      fontFamily: "Inter_600SemiBold",
      color: colors.mutedForeground,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginBottom: 10,
    },
    captureRow: {
      flexDirection: "row",
      gap: 12,
    },
    captureBtn: {
      flex: 1,
      borderRadius: colors.radius + 4,
      overflow: "hidden",
    },
    captureBtnInner: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 28,
      gap: 10,
      borderRadius: colors.radius + 4,
      borderWidth: 1.5,
    },
    captureBtnLabel: {
      fontSize: 13,
      fontFamily: "Inter_600SemiBold",
    },
    captureBtnSub: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
    },
    disabled: {
      opacity: 0.4,
    },
    projectCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    projectCardInfo: {
      flex: 1,
    },
    projectCardName: {
      fontSize: 14,
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
    },
    projectCardMeta: {
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      marginTop: 2,
    },
    hint: {
      fontSize: 12,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      textAlign: "center",
      marginTop: 16,
    },
    errorBox: {
      backgroundColor: "#fef2f2",
      borderRadius: colors.radius,
      padding: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    errorText: {
      flex: 1,
      fontSize: 13,
      color: colors.destructive,
      fontFamily: "Inter_400Regular",
    },
    projectListTitle: {
      fontSize: 15,
      fontFamily: "Inter_600SemiBold",
      color: colors.foreground,
      marginBottom: 10,
    },
    projectRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 10,
    },
    projectRowName: {
      flex: 1,
      fontSize: 14,
      fontFamily: "Inter_500Medium",
      color: colors.foreground,
    },
    projectRowBadge: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
      backgroundColor: colors.muted,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 4,
    },
    projectRowCount: {
      fontSize: 11,
      fontFamily: "Inter_400Regular",
      color: colors.mutedForeground,
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.logoRow}>
          <View style={styles.logoBox}>
            <Feather name="scissors" size={16} color={colors.primaryForeground} />
          </View>
          <Text style={styles.logoText}>
            <Text style={styles.logoCut}>Cut</Text>AI
          </Text>
        </View>
        <TouchableOpacity
          style={styles.queueBtn}
          onPress={() => router.push("/(tabs)/queue")}
        >
          <Feather name="upload-cloud" size={24} color={colors.foreground} />
          <UploadBadge />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: bottomPad + 24 }}
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <View style={[styles.section, styles.errorBox]}>
            <Feather name="wifi-off" size={16} color={colors.destructive} />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={reload}>
              <Feather name="refresh-cw" size={16} color={colors.destructive} />
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Target project</Text>
          {loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <ProjectPicker
              projects={projects}
              loading={loading}
              selected={selectedProject}
              onSelect={setSelectedProject}
            />
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Add footage</Text>
          <View style={[styles.captureRow, !selectedProject && styles.disabled]}>
            <TouchableOpacity
              style={styles.captureBtn}
              disabled={!selectedProject || picking}
              onPress={() => pickMedia("camera")}
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.captureBtnInner,
                  {
                    backgroundColor: colors.primary + "0d",
                    borderColor: colors.primary + "33",
                  },
                ]}
              >
                <Feather name="camera" size={28} color={colors.primary} />
                <Text style={[styles.captureBtnLabel, { color: colors.primary }]}>
                  Record
                </Text>
                <Text style={styles.captureBtnSub}>Shoot new footage</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.captureBtn}
              disabled={!selectedProject || picking}
              onPress={() => pickMedia("library")}
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.captureBtnInner,
                  {
                    backgroundColor: colors.accent + "12",
                    borderColor: colors.accent + "33",
                  },
                ]}
              >
                <Feather name="film" size={28} color={colors.accent} />
                <Text style={[styles.captureBtnLabel, { color: colors.accent }]}>
                  Gallery
                </Text>
                <Text style={styles.captureBtnSub}>Select from camera roll</Text>
              </View>
            </TouchableOpacity>
          </View>

          {!selectedProject && (
            <Text style={styles.hint}>Select a project first to add footage</Text>
          )}
        </View>

        {projects.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>All projects</Text>
            {projects.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={styles.projectRow}
                onPress={() => setSelectedProject(p)}
              >
                <Feather
                  name={(FORMAT_ICON[p.targetFormat] as any) ?? "folder"}
                  size={18}
                  color={selectedProject?.id === p.id ? colors.accent : colors.mutedForeground}
                />
                <Text style={styles.projectRowName} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={styles.projectRowBadge}>
                  {FORMAT_LABELS[p.targetFormat] ?? p.targetFormat}
                </Text>
                <Text style={styles.projectRowCount}>{p.videoCount} clips</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
