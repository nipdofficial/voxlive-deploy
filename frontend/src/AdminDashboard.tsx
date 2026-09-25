import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";

import {
  getAdminOverview,
  signOutSession,
  UnauthorizedError,
  type AdminOverview,
  type AdminSession,
  type AdminUser,
  type AuthSession,
} from "./authApi";
import { authPalette, type AuthPalette } from "./authTheme";

const REFRESH_MS = 15_000;

function relativeTime(value?: string | null) {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 45) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(value).toLocaleDateString();
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function deviceLabel(userAgent?: string | null) {
  if (!userAgent) return "Unknown device";
  if (/android/i.test(userAgent)) return "Android";
  if (/iphone|ipad|ios/i.test(userAgent)) return "iOS";
  if (/okhttp|expo|reactnative/i.test(userAgent)) return "Mobile app";
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/chrome/i.test(userAgent)) return "Chrome";
  if (/firefox/i.test(userAgent)) return "Firefox";
  if (/safari/i.test(userAgent)) return "Safari";
  return "Browser";
}

type View_ = "sessions" | "users";

export default function AdminDashboard({
  session,
  isDark,
  onToggleTheme,
  onSignOut,
  onSessionExpired,
}: {
  session: AuthSession;
  isDark: boolean;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onSessionExpired: () => void;
}) {
  const c = authPalette(isDark);
  const { width } = useWindowDimensions();
  const compact = width < 640;
  const styles = useMemo(() => createStyles(c, compact), [isDark, compact]);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<View_>("sessions");
  const [query, setQuery] = useState("");
  const [pendingSignOut, setPendingSignOut] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setData(await getAdminOverview(session.token));
      setUpdatedAt(new Date());
      setError(null);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) return onSessionExpired();
      setError(caught instanceof Error ? caught.message : "Could not load dashboard");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [session.token, onSessionExpired]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const forceSignOut = async (target: AdminSession) => {
    setPendingSignOut(target.id);
    try {
      await signOutSession(session.token, target.id);
      await load();
    } catch (caught) {
      if (caught instanceof UnauthorizedError) return onSessionExpired();
      setError(caught instanceof Error ? caught.message : "Could not sign out session");
    } finally {
      setPendingSignOut(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const matches = (item: { name: string; email: string }) =>
    !needle || item.name.toLowerCase().includes(needle) || item.email.toLowerCase().includes(needle);
  const sessions = (data?.sessions ?? []).filter(matches);
  const users = (data?.users ?? []).filter(matches);
  const ownSessionUserId = session.user.id;

  const stats = [
    { label: "Registered users", value: data?.total_users, icon: "users" as const },
    { label: "Signed in", value: data?.signed_in_users, icon: "log-in" as const },
    { label: "Online now", value: data?.online_users, icon: "activity" as const, live: true },
  ];

  return (
    <View style={styles.page}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <View style={styles.header}>
        <View style={styles.brand}>
          <LinearGradient colors={["#A78BFA", "#6D5CE7"]} style={styles.logo}>
            <MaterialCommunityIcons name="waveform" size={23} color="white" />
          </LinearGradient>
          <View>
            <Text style={styles.brandName}>VoxLive</Text>
            <Text style={styles.brandTagline}>ADMIN DASHBOARD</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Switch to ${isDark ? "light" : "dark"} mode`}
            onPress={onToggleTheme}
            style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.7 }]}
          >
            <Feather name={isDark ? "sun" : "moon"} size={17} color={isDark ? "#D8CDF8" : "#5C477A"} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={onSignOut}
            style={({ pressed }) => [styles.signOutButton, pressed && { opacity: 0.7 }]}
          >
            <Feather name="log-out" size={16} color={c.purpleText} />
            {compact ? null : <Text style={styles.signOutText}>Sign out</Text>}
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={c.accent} />}
      >
        <View style={styles.titleRow}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.title}>Who's signed in</Text>
            <Text style={styles.subtitle}>
              Signed in as {session.user.email}
              {updatedAt ? ` · Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh"
            onPress={() => void load(true)}
            style={({ pressed }) => [styles.refreshButton, pressed && { opacity: 0.7 }]}
          >
            {refreshing ? <ActivityIndicator size="small" color={c.purpleText} /> : <Feather name="refresh-cw" size={15} color={c.purpleText} />}
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <Feather name="alert-circle" size={16} color={c.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.stats}>
          {stats.map((stat) => (
            <View key={stat.label} style={styles.statCard}>
              <View style={styles.statHead}>
                <Feather name={stat.icon} size={15} color={c.muted} />
                <Text style={styles.statLabel}>{stat.label}</Text>
                {stat.live ? <View style={styles.liveDot} /> : null}
              </View>
              <Text style={styles.statValue}>{stat.value ?? "–"}</Text>
            </View>
          ))}
        </View>

        <View style={styles.toolbar}>
          <View style={styles.segment}>
            {([["sessions", "Active sessions", data?.sessions.length], ["users", "All users", data?.users.length]] as const).map(([key, label, count]) => (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected: view === key }}
                onPress={() => setView(key)}
                style={[styles.segmentItem, view === key && styles.segmentItemActive]}
              >
                <Text style={[styles.segmentText, view === key && styles.segmentTextActive]}>
                  {label}{count != null ? ` (${count})` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.search}>
            <Feather name="search" size={15} color={c.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search name or email"
              placeholderTextColor={c.muted}
              autoCapitalize="none"
              style={styles.searchInput}
            />
          </View>
        </View>

        {!data && !error ? (
          <View style={styles.empty}><ActivityIndicator color={c.accent} /></View>
        ) : view === "sessions" ? (
          sessions.length ? sessions.map((item) => (
            <SessionRow
              key={item.id}
              item={item}
              isSelf={item.user_id === ownSessionUserId}
              pending={pendingSignOut === item.id}
              onSignOut={() => void forceSignOut(item)}
              styles={styles}
              c={c}
            />
          )) : <Empty styles={styles} text={needle ? "No sessions match your search." : "Nobody is signed in right now."} />
        ) : users.length ? users.map((item) => (
          <UserRow key={item.id} item={item} styles={styles} c={c} />
        )) : <Empty styles={styles} text={needle ? "No users match your search." : "No one has registered yet."} />}
      </ScrollView>
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

function StatusPill({ online, signedIn, styles, c }: { online: boolean; signedIn: boolean; styles: Styles; c: AuthPalette }) {
  const [label, color, background] = online
    ? ["Online", c.success, c.successSurface]
    : signedIn ? ["Idle", c.purpleText, c.purpleSurface] : ["Signed out", c.muted, c.raised];
  return (
    <View style={[styles.pill, { backgroundColor: background }]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function Avatar({ name, admin, styles }: { name: string; admin?: boolean; styles: Styles }) {
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <View style={[styles.avatar, admin && styles.avatarAdmin]}>
      {admin ? <Feather name="shield" size={16} color="white" /> : <Text style={styles.avatarText}>{initials || "?"}</Text>}
    </View>
  );
}

function Meta({ icon, text, styles, c }: { icon: keyof typeof Feather.glyphMap; text: string; styles: Styles; c: AuthPalette }) {
  return (
    <View style={styles.meta}>
      <Feather name={icon} size={12} color={c.muted} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

function SessionRow({
  item, isSelf, pending, onSignOut, styles, c,
}: {
  item: AdminSession; isSelf: boolean; pending: boolean; onSignOut: () => void; styles: Styles; c: AuthPalette;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Avatar name={item.name} admin={item.role === "admin"} styles={styles} />
        <View style={styles.rowText}>
          <View style={styles.nameLine}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            {item.role === "admin" ? <Text style={styles.roleBadge}>ADMIN</Text> : null}
            {isSelf ? <Text style={styles.youBadge}>You</Text> : null}
          </View>
          <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
          <View style={styles.metaRow}>
            <Meta icon="log-in" text={`Signed in ${formatDate(item.signed_in_at)}`} styles={styles} c={c} />
            <Meta icon="clock" text={`Active ${relativeTime(item.last_seen_at)}`} styles={styles} c={c} />
            <Meta icon="monitor" text={`${deviceLabel(item.user_agent)}${item.ip ? ` · ${item.ip}` : ""}`} styles={styles} c={c} />
          </View>
        </View>
      </View>
      <View style={styles.rowSide}>
        <StatusPill online={item.online} signedIn styles={styles} c={c} />
        {isSelf ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sign out ${item.name}`}
            disabled={pending}
            onPress={onSignOut}
            style={({ pressed }) => [styles.dangerButton, (pressed || pending) && { opacity: 0.7 }]}
          >
            {pending ? <ActivityIndicator size="small" color={c.danger} /> : <Text style={styles.dangerText}>Sign out</Text>}
          </Pressable>
        )}
      </View>
    </View>
  );
}

function UserRow({ item, styles, c }: { item: AdminUser; styles: Styles; c: AuthPalette }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Avatar name={item.name} styles={styles} />
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
          <View style={styles.metaRow}>
            <Meta icon="user-plus" text={`Joined ${formatDate(item.created_at)}`} styles={styles} c={c} />
            <Meta icon="log-in" text={`Last sign-in ${relativeTime(item.last_login_at)}`} styles={styles} c={c} />
            <Meta icon="hash" text={`${item.login_count} sign-in${item.login_count === 1 ? "" : "s"}`} styles={styles} c={c} />
            {item.active_sessions > 1 ? <Meta icon="layers" text={`${item.active_sessions} devices`} styles={styles} c={c} /> : null}
          </View>
        </View>
      </View>
      <View style={styles.rowSide}>
        <StatusPill online={item.online} signedIn={item.signed_in} styles={styles} c={c} />
      </View>
    </View>
  );
}

function Empty({ text, styles }: { text: string; styles: Styles }) {
  return <View style={styles.empty}><Text style={styles.emptyText}>{text}</Text></View>;
}

function createStyles(c: AuthPalette, compact: boolean) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: c.bg },
    header: { height: Platform.OS === "web" ? 76 : 96, paddingTop: Platform.OS === "web" ? 0 : 22, paddingHorizontal: compact ? 16 : 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.header },
    brand: { flexDirection: "row", alignItems: "center", gap: 11 },
    logo: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
    brandName: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 19, letterSpacing: -0.4 },
    brandTagline: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 9, letterSpacing: 1 },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    iconButton: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
    signOutButton: { height: 40, minWidth: 40, paddingHorizontal: compact ? 0 : 14, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: c.purpleSurface },
    signOutText: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 14 },
    content: { width: "100%", maxWidth: 1080, alignSelf: "center", padding: compact ? 16 : 28, paddingBottom: 48, gap: 14 },
    titleRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 12 },
    title: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: compact ? 24 : 28, letterSpacing: -0.6 },
    subtitle: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 13, marginTop: 2 },
    refreshButton: { height: 36, paddingHorizontal: 12, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    refreshText: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 13 },
    errorBanner: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 11, padding: 12, backgroundColor: c.dangerSurface },
    errorText: { flex: 1, color: c.danger, fontFamily: "DMSans_500Medium", fontSize: 13 },
    stats: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
    statCard: { flexGrow: 1, flexBasis: compact ? "100%" : 0, minWidth: 160, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 18, gap: 8 },
    statHead: { flexDirection: "row", alignItems: "center", gap: 7 },
    statLabel: { color: c.muted, fontFamily: "DMSans_500Medium", fontSize: 13 },
    liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.success, marginLeft: "auto" },
    statValue: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 32, letterSpacing: -1, fontVariant: ["tabular-nums"] },
    toolbar: { flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", justifyContent: "space-between", gap: 10, marginTop: 6 },
    segment: { flexDirection: "row", backgroundColor: c.raised, borderRadius: 12, padding: 4 },
    segmentItem: { flexGrow: compact ? 1 : 0, height: 36, paddingHorizontal: 14, borderRadius: 9, alignItems: "center", justifyContent: "center" },
    segmentItemActive: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.strongBorder },
    segmentText: { color: c.muted, fontFamily: "DMSans_600SemiBold", fontSize: 13 },
    segmentTextActive: { color: c.text },
    search: { flexDirection: "row", alignItems: "center", gap: 8, height: 44, minWidth: compact ? undefined : 260, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    searchInput: { flex: 1, height: "100%", color: c.text, fontFamily: "DMSans_400Regular", fontSize: 14 },
    row: { flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 12, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 16 },
    rowMain: { flex: compact ? undefined : 1, flexDirection: "row", gap: 12, minWidth: 0 },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowSide: { flexDirection: "row", alignItems: "center", justifyContent: compact ? "space-between" : "flex-end", gap: 10 },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: c.purpleSurface },
    avatarAdmin: { backgroundColor: c.accent },
    avatarText: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 14 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flexShrink: 1, color: c.text, fontFamily: "DMSans_700Bold", fontSize: 15 },
    roleBadge: { color: "white", backgroundColor: c.accent, fontFamily: "DMSans_700Bold", fontSize: 10, letterSpacing: 0.6, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: "hidden" },
    youBadge: { color: c.muted, fontFamily: "DMSans_500Medium", fontSize: 12 },
    email: { color: c.body, fontFamily: "DMSans_400Regular", fontSize: 13 },
    metaRow: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4, marginTop: 6 },
    meta: { flexDirection: "row", alignItems: "center", gap: 5 },
    metaText: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 12 },
    pill: { flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
    pillDot: { width: 7, height: 7, borderRadius: 4 },
    pillText: { fontFamily: "DMSans_600SemiBold", fontSize: 12 },
    dangerButton: { height: 32, minWidth: 84, paddingHorizontal: 12, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: c.dangerSurface },
    dangerText: { color: c.danger, fontFamily: "DMSans_600SemiBold", fontSize: 13 },
    empty: { alignItems: "center", justifyContent: "center", paddingVertical: 48, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", borderColor: c.border },
    emptyText: { color: c.muted, fontFamily: "DMSans_500Medium", fontSize: 14 },
  });
}
