import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import * as FileSystem from "expo-file-system";

export type UploadStatus =
  | "queued"
  | "uploading"
  | "done"
  | "error";

export interface UploadItem {
  id: string;
  localUri: string;
  filename: string;
  projectId: string;
  projectName: string;
  status: UploadStatus;
  progress: number;
  errorMessage?: string;
  videoId?: string;
  createdAt: number;
}

interface UploadContextValue {
  queue: UploadItem[];
  enqueue: (item: Omit<UploadItem, "id" | "status" | "progress" | "createdAt">) => void;
  removeItem: (id: string) => void;
  retryItem: (id: string) => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

const STORAGE_KEY = "cutai_upload_queue";
const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "/api";

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const processingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved: UploadItem[] = JSON.parse(raw);
        const reset = saved.map((item) =>
          item.status === "uploading" ? { ...item, status: "queued" as UploadStatus } : item
        );
        setQueue(reset);
      } catch {}
    });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  }, [queue]);

  const updateItem = useCallback(
    (id: string, patch: Partial<UploadItem>) => {
      setQueue((prev) =>
        prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
      );
    },
    []
  );

  const processItem = useCallback(
    async (item: UploadItem) => {
      if (processingRef.current.has(item.id)) return;
      processingRef.current.add(item.id);
      updateItem(item.id, { status: "uploading", progress: 10 });

      try {
        const result = await FileSystem.uploadAsync(
          `${API_BASE}/videos`,
          item.localUri,
          {
            httpMethod: "POST",
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            fieldName: "file",
            mimeType: "video/mp4",
            parameters: { projectId: item.projectId },
            headers: { Accept: "application/json" },
          }
        );

        if (result.status < 200 || result.status >= 300) {
          throw new Error(result.body || `HTTP ${result.status}`);
        }

        const json = JSON.parse(result.body);
        updateItem(item.id, {
          status: "done",
          progress: 100,
          videoId: json.id,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        updateItem(item.id, { status: "error", errorMessage: msg });
      } finally {
        processingRef.current.delete(item.id);
      }
    },
    [updateItem]
  );

  useEffect(() => {
    const pending = queue.filter(
      (it) => it.status === "queued" && !processingRef.current.has(it.id)
    );
    pending.forEach(processItem);
  }, [queue, processItem]);

  const enqueue = useCallback(
    (item: Omit<UploadItem, "id" | "status" | "progress" | "createdAt">) => {
      const newItem: UploadItem = {
        ...item,
        id: uid(),
        status: "queued",
        progress: 0,
        createdAt: Date.now(),
      };
      setQueue((prev) => [newItem, ...prev]);
    },
    []
  );

  const removeItem = useCallback((id: string) => {
    setQueue((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const retryItem = useCallback(
    (id: string) => {
      updateItem(id, { status: "queued", progress: 0, errorMessage: undefined });
    },
    [updateItem]
  );

  return (
    <UploadContext.Provider value={{ queue, enqueue, removeItem, retryItem }}>
      {children}
    </UploadContext.Provider>
  );
}

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used inside UploadProvider");
  return ctx;
}
