import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";

import {
  approveQrLogin,
  getQrLoginStatus,
  login,
  register,
  startQrLogin,
  type AuthSession,
} from "./authApi";
import { authPalette, type AuthPalette } from "./authTheme";

type Mode = "login" | "register";

export default function AuthScreen({
  isDark,
  onToggleTheme,
  onSignedIn,
  initialNotice,
}: {
  isDark: boolean;
  onToggleTheme: () => void;
  onSignedIn: (session: AuthSession) => void;
  initialNotice?: string | null;
}) {
  const c = authPalette(isDark);
  const styles = useMemo(() => createStyles(c), [isDark]);
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [qrToken] = useState<string | null>(() => (
    Platform.OS === "web" ? new URLSearchParams(window.location.search).get("qr") : null
  ));
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword("");
    setConfirm("");
  };

  useEffect(() => {
    if (!qrCode) return;
    const token = new URLSearchParams(window.location.search).get("qr");
    if (!token) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await getQrLoginStatus(token);
        if (cancelled) return;
        if (result.status === "approved" && result.token && result.user) {
          onSignedIn({ token: result.token, expires_at: result.expires_at ?? new Date().toISOString(), user: result.user });
          return;
        }
        if (result.status === "expired") {
          setQrCode(null);
          setError("This QR code expired. Generate a new one.");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "QR sign-in failed");
      }
    };
    const timer = setInterval(() => void poll(), 1500);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [qrCode, onSignedIn]);

  const beginQrLogin = async () => {
    if (Platform.OS !== "web" || qrBusy) return;
    setQrBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { token } = await startQrLogin();
      const { default: QRCode } = await import("qrcode");
      const url = new URL(window.location.href);
      url.searchParams.set("qr", token);
      url.hash = "";
      setQrCode(await QRCode.toDataURL(url.toString(), { margin: 2, width: 240 }));
      window.history.replaceState({}, "", url);
      setNotice("Scan this code with another device to approve sign-in.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a QR code");
    } finally {
      setQrBusy(false);
    }
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    const trimmedEmail = email.trim();
    if (mode === "register") {
      if (!name.trim()) return setError("Enter your name");
      if (!trimmedEmail) return setError("Enter your email address");
      if (password.length < 8) return setError("Password must be at least 8 characters");
      if (password !== confirm) return setError("Passwords do not match");
    } else if (!trimmedEmail || !password) {
      return setError("Enter your email and password");
    }
    if (qrToken) {
      setBusy(true);
      try {
        await approveQrLogin(qrToken, trimmedEmail, password);
        setError(null);
        setNotice("Sign-in approved. Return to the device that displayed the QR code.");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "QR sign-in failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      if (mode === "register") {
        await register(name.trim(), trimmedEmail, password);
        setMode("login");
        setPassword("");
        setConfirm("");
        setNotice("Account created. Sign in to continue.");
        passwordRef.current?.focus();
      } else {
        onSignedIn(await login(trimmedEmail, password));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const isRegister = mode === "register";

  return (
    <View style={styles.page}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <View style={styles.glow} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch to ${isDark ? "light" : "dark"} mode`}
        onPress={onToggleTheme}
        style={({ pressed }) => [styles.themeButton, pressed && { opacity: 0.7 }]}
      >
        <Feather name={isDark ? "sun" : "moon"} size={17} color={isDark ? "#D8CDF8" : "#5C477A"} />
      </Pressable>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <View style={styles.brand}>
              <LinearGradient colors={["#A78BFA", "#6D5CE7"]} style={styles.logo}>
                <MaterialCommunityIcons name="waveform" size={25} color="white" />
              </LinearGradient>
              <View>
                <Text style={styles.brandName}>VoxLive</Text>
                <Text style={styles.brandTagline}>VOICE TO TEXT, BEAUTIFULLY</Text>
              </View>
            </View>

            {!qrToken ? <View style={styles.segment} accessibilityRole="tablist">
              {(["login", "register"] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === item }}
                  onPress={() => switchMode(item)}
                  style={[styles.segmentItem, mode === item && styles.segmentItemActive]}
                >
                  <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>
                    {item === "login" ? "Sign in" : "Create account"}
                  </Text>
                </Pressable>
              ))}
            </View> : null}

            <Text style={styles.title}>{qrToken ? "Approve sign-in" : isRegister ? "Create your account" : "Welcome back"}</Text>
            <Text style={styles.subtitle}>
              {qrToken
                ? "Enter your VoxLive credentials to approve this device."
                : isRegister
                ? "Register once, then sign in to start transcribing."
                : "Sign in to continue to your transcripts."}
            </Text>

            {notice ? (
              <View style={[styles.banner, styles.bannerSuccess]}>
                <Feather name="check-circle" size={16} color={c.success} />
                <Text style={[styles.bannerText, { color: c.success }]}>{notice}</Text>
              </View>
            ) : null}
            {error ? (
              <View style={[styles.banner, styles.bannerError]} accessibilityLiveRegion="polite">
                <Feather name="alert-circle" size={16} color={c.danger} />
                <Text style={[styles.bannerText, { color: c.danger }]}>{error}</Text>
              </View>
            ) : null}

            {isRegister ? (
              <Field label="Full name" styles={styles}>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Your name"
                  placeholderTextColor={c.muted}
                  autoComplete="name"
                  textContentType="name"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                  style={styles.input}
                />
              </Field>
            ) : null}

            <Field label="Email" styles={styles}>
              <TextInput
                ref={emailRef}
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={c.muted}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                style={styles.input}
              />
            </Field>

            <Field label="Password" styles={styles} hint={isRegister ? "At least 8 characters" : undefined}>
              <View style={styles.passwordRow}>
                <TextInput
                  ref={passwordRef}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  placeholderTextColor={c.muted}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  textContentType={isRegister ? "newPassword" : "password"}
                  returnKeyType={isRegister ? "next" : "go"}
                  onSubmitEditing={() => (isRegister ? confirmRef.current?.focus() : void submit())}
                  style={[styles.input, { flex: 1, paddingRight: 46 }]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                  onPress={() => setShowPassword((value) => !value)}
                  style={styles.eyeButton}
                >
                  <Feather name={showPassword ? "eye-off" : "eye"} size={17} color={c.muted} />
                </Pressable>
              </View>
            </Field>

            {isRegister ? (
              <Field label="Confirm password" styles={styles}>
                <TextInput
                  ref={confirmRef}
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder="••••••••"
                  placeholderTextColor={c.muted}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoComplete="new-password"
                  textContentType="newPassword"
                  returnKeyType="go"
                  onSubmitEditing={() => void submit()}
                  style={styles.input}
                />
              </Field>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void submit()}
              style={({ pressed }) => [styles.primaryButton, (pressed || busy) && { opacity: 0.8 }]}
            >
              {busy ? <ActivityIndicator color="white" /> : (
                <Text style={styles.primaryButtonText}>{isRegister ? "Create account" : "Sign in"}</Text>
              )}
            </Pressable>

            {!isRegister && !qrToken && Platform.OS === "web" ? (
              <>
                {qrCode ? (
                  <View style={styles.qrPanel}>
                    <Image source={{ uri: qrCode }} style={styles.qrImage} />
                    <Text style={styles.qrHelp}>Waiting for approval...</Text>
                  </View>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={qrBusy}
                  onPress={() => void beginQrLogin()}
                  style={({ pressed }) => [styles.secondaryButton, (pressed || qrBusy) && { opacity: 0.7 }]}
                >
                  {qrBusy ? <ActivityIndicator color={c.purpleText} /> : <Text style={styles.secondaryButtonText}>Sign in with QR code</Text>}
                </Pressable>
              </>
            ) : null}

            <View style={styles.footer}>
              <Text style={styles.footerText}>
                {qrToken ? "Finished approving?" : isRegister ? "Already have an account?" : "New to VoxLive?"}
              </Text>
              <Pressable accessibilityRole="button" onPress={() => {
                if (qrToken && Platform.OS === "web") window.location.href = window.location.origin;
                else switchMode(isRegister ? "login" : "register");
              }}>
                <Text style={styles.footerLink}>{qrToken ? "Open regular sign in" : isRegister ? "Sign in" : "Create an account"}</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Field({
  label,
  hint,
  styles,
  children,
}: {
  label: string;
  hint?: string;
  styles: ReturnType<typeof createStyles>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function createStyles(c: AuthPalette) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg, overflow: "hidden" },
    glow: { position: "absolute", width: 520, height: 520, borderRadius: 260, top: -220, alignSelf: "center", backgroundColor: c.glow },
    themeButton: { position: "absolute", top: Platform.OS === "web" ? 20 : 48, right: 20, zIndex: 2, width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
    scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingVertical: 72 },
    card: { width: "100%", maxWidth: 420, backgroundColor: c.surface, borderRadius: 22, borderWidth: 1, borderColor: c.border, padding: 26, gap: 4 },
    brand: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 22 },
    logo: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center" },
    brandName: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 21, letterSpacing: -0.4 },
    brandTagline: { color: c.muted, fontFamily: "DMSans_500Medium", fontSize: 9, letterSpacing: 1 },
    segment: { flexDirection: "row", backgroundColor: c.raised, borderRadius: 12, padding: 4, marginBottom: 20 },
    segmentItem: { flex: 1, height: 38, borderRadius: 9, alignItems: "center", justifyContent: "center" },
    segmentItemActive: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.strongBorder },
    segmentText: { color: c.muted, fontFamily: "DMSans_600SemiBold", fontSize: 14 },
    segmentTextActive: { color: c.text },
    title: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 24, letterSpacing: -0.5 },
    subtitle: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 14, lineHeight: 20, marginBottom: 14 },
    banner: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
    bannerSuccess: { backgroundColor: c.successSurface },
    bannerError: { backgroundColor: c.dangerSurface },
    bannerText: { flex: 1, fontFamily: "DMSans_500Medium", fontSize: 13, lineHeight: 18 },
    field: { gap: 6, marginTop: 10 },
    label: { color: c.body, fontFamily: "DMSans_600SemiBold", fontSize: 13 },
    hint: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 12 },
    input: { height: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, color: c.text, paddingHorizontal: 14, fontFamily: "DMSans_400Regular", fontSize: 15 },
    passwordRow: { flexDirection: "row", alignItems: "center" },
    eyeButton: { position: "absolute", right: 4, width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    primaryButton: { height: 50, borderRadius: 13, backgroundColor: c.accent, alignItems: "center", justifyContent: "center", marginTop: 22 },
    primaryButtonText: { color: "white", fontFamily: "DMSans_700Bold", fontSize: 15 },
    secondaryButton: { height: 46, borderRadius: 13, borderWidth: 1, borderColor: c.strongBorder, alignItems: "center", justifyContent: "center", marginTop: 12 },
    secondaryButtonText: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 14 },
    qrPanel: { alignItems: "center", gap: 8, marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: c.bg },
    qrImage: { width: 240, height: 240 },
    qrHelp: { color: c.muted, fontFamily: "DMSans_500Medium", fontSize: 13 },
    footer: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap", gap: 6, marginTop: 18 },
    footerText: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 14 },
    footerLink: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 14 },
  });
}
