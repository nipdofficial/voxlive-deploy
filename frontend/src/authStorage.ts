import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import type { AuthSession } from "./authApi";

const STORAGE_KEY = "voxlive.session";

function sessionFile() {
  return new File(Paths.document, "voxlive-session.json");
}

export function loadSession(): AuthSession | null {
  try {
    const raw = Platform.OS === "web"
      ? window.localStorage.getItem(STORAGE_KEY)
      : sessionFile().exists ? sessionFile().textSync() : null;
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!session?.token || new Date(session.expires_at).getTime() <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession) {
  try {
    const raw = JSON.stringify(session);
    if (Platform.OS === "web") window.localStorage.setItem(STORAGE_KEY, raw);
    else sessionFile().write(raw);
  } catch { /* Persistence is a convenience; the in-memory session still works. */ }
}

export function clearSession() {
  try {
    if (Platform.OS === "web") window.localStorage.removeItem(STORAGE_KEY);
    else if (sessionFile().exists) sessionFile().delete();
  } catch { /* Nothing to clear. */ }
}
