import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

interface GoogleUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

async function fetchMe(): Promise<GoogleUser | null> {
  const res = await fetch(`${API_BASE}/auth/me`, { credentials: "include" });
  if (!res.ok) return null;
  const data = await res.json();
  return data.user ?? null;
}

export function useAuth() {
  const queryClient = useQueryClient();

  const { data: user, isLoading } = useQuery<GoogleUser | null>({
    queryKey: ["auth", "me"],
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
  });

  const logout = useMutation({
    mutationFn: async () => {
      await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
    },
    onSuccess: () => {
      queryClient.setQueryData(["auth", "me"], null);
    },
  });

  const signInUrl = `${API_BASE}/auth/google`;

  return { user, isLoading, logout, signInUrl };
}
