import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View, useColorScheme } from "react-native";
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

// Keeps the admin dashboard's "Online now" accurate while a user has the app open.
const HEARTBEAT_MS = 60_000;

/** Routes between sign-in, the admin dashboard and the transcription app by role. */
export default function Root() {
  const [fontsLoaded] = useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold });
  const systemScheme = useColorScheme();
  const [isDark, setIsDark] = useState(systemScheme !== "light");
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [verifying, setVerifying] = useState(session !== null);
  const [notice, setNotice] = useState<string | null>(null);

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

  if (!fontsLoaded || (session && verifying)) {
    return (
      <View style={{ flex: 1, backgroundColor: authPalette(isDark).bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#9F7AEA" />
      </View>
    );
  }

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
