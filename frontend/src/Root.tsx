import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, View, useColorScheme } from "react-native";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";

import App from "./App";
import AdminDashboard from "./AdminDashboard";
import AuthScreen from "./AuthScreen";
import { getMe, logout, UnauthorizedError, type AuthSession } from "./authApi";
import { clearSession, loadSession, saveSession } from "./authStorage";
import { authPalette } from "./authTheme";
import GuestAttendeeScreen from "./GuestAttendeeScreen";

// Keeps the admin dashboard's "Online now" accurate while a user has the app open.
const HEARTBEAT_MS = 60_000;

/** Routes between sign-in, the admin dashboard and the transcription app by role. */
export default function Root() {
  // Font loading is enhancement-only. A blocked font request must not prevent
  // the authentication screen and the rest of the app from rendering.
  useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold });
  const systemScheme = useColorScheme();
  const [isDark, setIsDark] = useState(systemScheme !== "light");
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [verifying, setVerifying] = useState(session !== null);
  const [notice, setNotice] = useState<string | null>(null);
  const guestRoomCode = Platform.OS === "web" && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("session")?.trim().toUpperCase() ?? null
    : null;

  const endLocalSession = useCallback((message: string | null) => {
    clearSession();
    setSession(null);
    setNotice(message);
  }, []);

  const handleSessionExpired = useCallback(
    () => endLocalSession("Your session has ended. Please sign in again."),
    [endLocalSession],
  );

  const handleSignedIn = useCallback((next: AuthSession) => {
    saveSession(next);
    setNotice(null);
    setSession(next);
  }, []);

  const handleSignOut = useCallback(() => {
    if (session) void logout(session.token).catch(() => undefined);
    endLocalSession(null);
  }, [session, endLocalSession]);

  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      const bg = authPalette(isDark).bg;
      document.documentElement.style.backgroundColor = bg;
      document.body.style.backgroundColor = bg;
    }
  }, [isDark]);

  // Confirm a restored session is still valid, then keep it marked active.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const ping = async () => {
      try {
        const user = await getMe(session.token);
        if (!cancelled && user.role !== session.user.role) handleSessionExpired();
      } catch (caught) {
        // Network errors keep the session so the app still works offline.
        if (!cancelled && caught instanceof UnauthorizedError) handleSessionExpired();
      } finally {
        if (!cancelled) setVerifying(false);
      }
    };
    void ping();
    const timer = setInterval(() => void ping(), HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session, handleSessionExpired]);

  if (session && verifying) {
    return (
      <View style={{ flex: 1, backgroundColor: authPalette(isDark).bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#9F7AEA" />
      </View>
    );
  }

  // QR attendee links are public meeting links. They must bypass account
  // authentication and show only the guest session experience.
  if (guestRoomCode) return <GuestAttendeeScreen roomCode={guestRoomCode} />;

  if (!session) {
    return (
      <AuthScreen
        key={notice ?? "auth"}
        isDark={isDark}
        onToggleTheme={() => setIsDark((value) => !value)}
        onSignedIn={handleSignedIn}
        initialNotice={notice}
      />
    );
  }

  if (session.user.role === "admin") {
    return (
      <AdminDashboard
        session={session}
        isDark={isDark}
        onToggleTheme={() => setIsDark((value) => !value)}
        onSignOut={handleSignOut}
        onSessionExpired={handleSessionExpired}
      />
    );
  }

  return <App onSignOut={handleSignOut} />;
}
