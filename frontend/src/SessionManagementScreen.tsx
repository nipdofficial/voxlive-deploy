import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";

import { createMeeting, getHistory, getSessionInfo, getSessionQrUrl } from "./api";
import type { Language, MeetingConnection, SessionInfo, TranscriptRecord } from "./types";

interface SessionManagementScreenProps {
  onOpenCreatedSession: (connection: MeetingConnection, title: string) => void;
  isDark: boolean;
}

export function SessionManagementScreen({ onOpenCreatedSession, isDark }: SessionManagementScreenProps) {
  const { width } = useWindowDimensions();
  const isWide = width >= 800;

  // Create form state
  const [organizerName, setOrganizerName] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("50");
  const [language, setLanguage] = useState<Language>("Mixed");
  const [creating, setCreating] = useState(false);

  // Active session state (after organizer creates one)
  const [activeSession, setActiveSession] = useState<{
    code: string;
    title: string;
    qrUrl: string;
    connection: MeetingConnection;
    joinUrl: string;
    info?: SessionInfo;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [refreshingInfo, setRefreshingInfo] = useState(false);
  const [pastSessions, setPastSessions] = useState<TranscriptRecord[]>([]);


  useEffect(() => { void getHistory().then(setPastSessions).catch(() => undefined); }, [activeSession?.info?.is_active]);

  const downloadTranscript = async (record: TranscriptRecord) => {
    const contents = record.segments.map((segment) => `${segment.speaker || "Speaker"}: ${segment.translated_text || segment.text}`).join("\n");
    if (!contents.trim()) return;
    const filename = `${record.title.replace(/[^a-z0-9]+/gi, "_") || "voxlive_session"}.txt`;
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }
    const file = new File(Paths.cache, filename);
    file.create({ overwrite: true });
    file.write(contents);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { dialogTitle: "Save translated transcript", mimeType: "text/plain", UTI: "public.plain-text" });
  };

  const handleCreateSession = async () => {
    if (!organizerName.trim()) {
      Alert.alert("Required", "Please enter your organizer display name.");
      return;
    }
    const parsedLimit = parseInt(maxParticipants, 10);
    if (isNaN(parsedLimit) || parsedLimit < 1) {
      Alert.alert("Invalid Limit", "Please enter a valid participant limit (at least 1).");
      return;
    }

    setCreating(true);
    try {
      const conn = await createMeeting(
        organizerName.trim(),
        language,
        false,
        sessionTitle.trim() || undefined,
        parsedLimit,
      );

      const qrUrl = getSessionQrUrl(conn.room_code);
      const info = await getSessionInfo(conn.room_code).catch(() => undefined);

      setActiveSession({
        code: conn.room_code,
        title: sessionTitle.trim() || "Event Session",
        qrUrl,
        connection: conn,
        joinUrl: `${typeof window !== "undefined" ? window.location.origin : "https://voxlive-deploy-frontend.vercel.app"}/?session=${conn.room_code}`,
        info,
      });
    } catch (err) {
      Alert.alert("Error Creating Session", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!activeSession) return;
    const timer = setInterval(() => {
      void getSessionInfo(activeSession.code).then((info) => {
        setActiveSession((previous) => previous ? { ...previous, info } : previous);
      }).catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [activeSession?.code]);

  const handleRefreshInfo = async () => {
    if (!activeSession) return;
    setRefreshingInfo(true);
    try {
      const info = await getSessionInfo(activeSession.code);
      setActiveSession((prev) => (prev ? { ...prev, info } : null));
    } catch (err) {
      console.warn("Could not refresh session info", err);
    } finally {
      setRefreshingInfo(false);
    }
  };

  const handleCopyCode = async () => {
    if (!activeSession) return;
    await Clipboard.setStringAsync(activeSession.code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleCopyLink = async () => {
    if (!activeSession) return;
    await Clipboard.setStringAsync(activeSession.joinUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const styles = getStyles(isDark);
  const completedSessions = pastSessions.filter((record) => record.status === "completed" || record.status === "failed");

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>SESSION MANAGEMENT</Text>
        <Text style={styles.title}>Event Sessions & QR Access</Text>
        <Text style={styles.subtitle}>
          Organizers can create managed event sessions with participant caps and automatically generated QR codes.
        </Text>
      </View>

      <View style={[styles.card, { marginBottom: 22 }]}>
        <Text style={styles.cardHeader}>Session control</Text>
        <Text style={styles.hint}>Manage ongoing sessions and download saved transcripts.</Text>
        <Text style={[styles.label, { marginTop: 18 }]}>ONGOING SESSIONS</Text>
        {activeSession?.info?.is_active ? <View style={styles.sessionListRow}><View style={{ flex: 1 }}><Text style={styles.sessionTitle}>{activeSession.title}</Text><Text style={styles.sessionCodeLabel}>Room {activeSession.code} · {activeSession.info.current_participants} connected</Text></View><Text style={styles.liveStatus}>LIVE</Text></View> : <Text style={styles.emptySession}>No ongoing sessions</Text>}
        <Text style={[styles.label, { marginTop: 18 }]}>UPCOMING SESSIONS</Text>
        <Text style={styles.emptySession}>No upcoming sessions</Text>
        <Text style={[styles.label, { marginTop: 18 }]}>PAST SESSIONS</Text>
        {completedSessions.length ? completedSessions.map((record) => <View key={record.id} style={styles.sessionListRow}><View style={{ flex: 1 }}><Text style={styles.sessionTitle}>{record.title}</Text><Text style={styles.sessionCodeLabel}>{record.language} · {record.status} · {new Date(record.created_at).toLocaleDateString()}</Text></View><Pressable onPress={() => void downloadTranscript(record)} disabled={!record.segments.length} style={[styles.downloadButton, !record.segments.length && { opacity: 0.45 }]}><Feather name="download" size={15} color="#A78BFA" /><Text style={styles.downloadText}>TXT</Text></Pressable></View>) : <Text style={styles.emptySession}>No saved sessions yet</Text>}
      </View>

      {activeSession ? (
          /* Active Created Session View */
          <View style={[styles.card, isWide && styles.cardWide]}>
            <View style={styles.sessionHeaderRow}>
              <View>
                <Text style={styles.sessionTitle}>{activeSession.title}</Text>
                <Text style={styles.sessionCodeLabel}>
                  Session Code: <Text style={styles.sessionCodeValue}>{activeSession.code}</Text>
                </Text>
              </View>
              <Pressable style={styles.refreshButton} onPress={handleRefreshInfo} disabled={refreshingInfo}>
                {refreshingInfo ? (
                  <ActivityIndicator size="small" color="#A78BFA" />
                ) : (
                  <Feather name="refresh-cw" size={18} color="#A78BFA" />
                )}
              </Pressable>
            </View>

            {/* QR Code Container */}
            <View style={styles.qrSection}>
              <Text style={styles.qrInstruction}>
                Scan QR Code to join this session automatically
              </Text>
              <View style={styles.qrImageContainer}>
                <Image
                  source={{ uri: activeSession.qrUrl }}
                  style={styles.qrImage}
                  resizeMode="contain"
                />
              </View>
              <View style={styles.actionRow}>
                <Pressable style={styles.secondaryButton} onPress={handleCopyCode}>
                  <Feather name={copiedCode ? "check" : "copy"} size={16} color="#A78BFA" />
                  <Text style={styles.secondaryButtonText}>
                    {copiedCode ? "Code Copied!" : "Copy Session Code"}
                  </Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={handleCopyLink}>
                  <Feather name={copiedLink ? "check" : "link"} size={16} color="#A78BFA" />
                  <Text style={styles.secondaryButtonText}>{copiedLink ? "Link Copied!" : "Copy Join Link"}</Text>
                </Pressable>
              </View>
              <Text numberOfLines={2} style={{ color: "#8F8A9E", fontSize: 10, textAlign: "center", marginTop: 9 }}>{activeSession.joinUrl}</Text>
            </View>

            {/* Participant Stats */}
            {activeSession.info ? (
              <View style={styles.statsContainer}>
                <View style={styles.statBox}>
                  <Text style={styles.statNumber}>
                    {activeSession.info.current_participants} / {activeSession.info.max_participants}
                  </Text>
                  <Text style={styles.statLabel}>Participants Joined</Text>
                </View>
                <View style={styles.statBox}>
                  <Text style={styles.statNumber}>
                    {activeSession.info.is_active ? "Active" : "Ended"}
                  </Text>
                  <Text style={styles.statLabel}>Status</Text>
                </View>
              </View>
            ) : null}

            <Pressable
              style={[styles.primaryButton, { marginTop: 24 }]}
              onPress={() => onOpenCreatedSession(activeSession.connection, activeSession.title)}
            >
              <Feather name="mic" size={18} color="white" />
              <Text style={styles.primaryButtonText}>Enter Session Room</Text>
            </Pressable>

            <Pressable
              style={styles.textButton}
              onPress={() => setActiveSession(null)}
            >
              <Text style={styles.textButtonText}>Create Another Session</Text>
            </Pressable>
          </View>
        ) : (
          /* Create Session Form */
          <View style={[styles.card, isWide && styles.cardWide]}>
            <Text style={styles.cardHeader}>Create New Event Session</Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Organizer Display Name</Text>
              <TextInput
                style={styles.input}
                value={organizerName}
                onChangeText={setOrganizerName}
                placeholder="e.g. John (Host)"
                placeholderTextColor="#625E70"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Session / Event Title</Text>
              <TextInput
                style={styles.input}
                value={sessionTitle}
                onChangeText={setSessionTitle}
                placeholder="e.g. Keynote Presentation 2026"
                placeholderTextColor="#625E70"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Speaker input language</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {(["Sinhala", "Mixed"] as Language[]).map((option) => <Pressable key={option} onPress={() => setLanguage(option)} style={{ paddingHorizontal: 11, paddingVertical: 8, borderRadius: 9, borderWidth: 1, borderColor: language === option ? "#8067CE" : "rgba(255,255,255,0.12)", backgroundColor: language === option ? "#755BD0" : "rgba(255,255,255,0.05)" }}><Text style={{ color: language === option ? "white" : "#B8B1C8", fontSize: 11, fontWeight: "600" }}>{option}</Text></Pressable>)}
              </View>
              <Text style={styles.hint}>Choose one language for better live recognition, or use Mixed for automatic detection.</Text>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Maximum Participants</Text>
              <TextInput
                style={styles.input}
                value={maxParticipants}
                onChangeText={setMaxParticipants}
                placeholder="50"
                keyboardType="number-pad"
                placeholderTextColor="#625E70"
              />
              <Text style={styles.hint}>
                Limits how many participants can join this session simultaneously.
              </Text>
            </View>

            <Pressable
              style={styles.primaryButton}
              onPress={handleCreateSession}
              disabled={creating}
            >
              {creating ? (
                <ActivityIndicator color="white" />
              ) : (
                <>
                  <Feather name="plus-circle" size={18} color="white" />
                  <Text style={styles.primaryButtonText}>Generate Session & QR Code</Text>
                </>
              )}
            </Pressable>
          </View>
        )
      )}
    </ScrollView>
  );
}

const getStyles = (isDark: boolean) =>
  StyleSheet.create({
    container: {
      padding: 24,
      alignItems: "center",
      maxWidth: 900,
      alignSelf: "center",
      width: "100%",
    },
    header: {
      alignItems: "center",
      marginBottom: 24,
      textAlign: "center",
    },
    eyebrow: {
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1.5,
      color: "#A78BFA",
      marginBottom: 6,
    },
    title: {
      fontSize: 26,
      fontWeight: "700",
      color: isDark ? "#F3F0FF" : "#1E1A29",
      marginBottom: 8,
    },
    subtitle: {
      fontSize: 14,
      color: isDark ? "#A09AAB" : "#645E73",
      textAlign: "center",
      maxWidth: 540,
      lineHeight: 20,
    },
    tabContainer: {
      flexDirection: "row",
      backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
      borderRadius: 12,
      padding: 4,
      marginBottom: 24,
    },
    tabButton: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 10,
      paddingHorizontal: 20,
      borderRadius: 8,
      gap: 8,
    },
    tabButtonActive: {
      backgroundColor: isDark ? "#2B263B" : "#FFFFFF",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
    },
    tabText: {
      fontSize: 14,
      fontWeight: "600",
      color: isDark ? "#8F8A9E" : "#645E73",
    },
    tabTextActive: {
      color: isDark ? "#F3F0FF" : "#1E1A29",
    },
    card: {
      width: "100%",
      backgroundColor: isDark ? "#1C1829" : "#FFFFFF",
      borderRadius: 16,
      padding: 24,
      borderWidth: 1,
      borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
    },
    cardWide: {
      maxWidth: 560,
    },
    cardHeader: {
      fontSize: 18,
      fontWeight: "700",
      color: isDark ? "#F3F0FF" : "#1E1A29",
      marginBottom: 20,
    },
    fieldGroup: {
      marginBottom: 18,
    },
    label: {
      fontSize: 13,
      fontWeight: "600",
      color: isDark ? "#C4C0D0" : "#4A4557",
      marginBottom: 6,
    },
    input: {
      backgroundColor: isDark ? "#120E1C" : "#F5F3F9",
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: isDark ? "#F3F0FF" : "#1E1A29",
      borderWidth: 1,
      borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
    },
    hint: {
      fontSize: 12,
      color: isDark ? "#7F7A8C" : "#8F8A9E",
      marginTop: 6,
    },
    primaryButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#6D5CE7",
      borderRadius: 10,
      paddingVertical: 14,
      gap: 10,
      marginTop: 8,
    },
    primaryButtonText: {
      color: "white",
      fontSize: 15,
      fontWeight: "600",
    },
    secondaryButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: isDark ? "rgba(167, 139, 250, 0.12)" : "rgba(109, 92, 231, 0.08)",
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 16,
      gap: 8,
    },
    secondaryButtonText: {
      color: "#A78BFA",
      fontSize: 14,
      fontWeight: "600",
    },
    textButton: {
      alignItems: "center",
      marginTop: 14,
    },
    textButtonText: {
      color: isDark ? "#A09AAB" : "#645E73",
      fontSize: 14,
    },
    sessionHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 20,
    },
    sessionTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: isDark ? "#F3F0FF" : "#1E1A29",
      marginBottom: 4,
    },
    sessionCodeLabel: {
      fontSize: 13,
      color: isDark ? "#A09AAB" : "#645E73",
    },
    sessionCodeValue: {
      fontWeight: "700",
      color: "#A78BFA",
    },
    refreshButton: {
      padding: 8,
    },
    qrSection: {
      alignItems: "center",
      backgroundColor: isDark ? "#120E1C" : "#F5F3F9",
      borderRadius: 12,
      padding: 20,
      marginBottom: 20,
    },
    qrInstruction: {
      fontSize: 13,
      color: isDark ? "#A09AAB" : "#645E73",
      marginBottom: 16,
      textAlign: "center",
    },
    qrImageContainer: {
      backgroundColor: "white",
      padding: 12,
      borderRadius: 12,
      marginBottom: 16,
    },
    qrImage: {
      width: 180,
      height: 180,
    },
    actionRow: {
      flexDirection: "row",
      gap: 10,
    },
    statsContainer: {
      flexDirection: "row",
      gap: 12,
    },
    statBox: {
      flex: 1,
      backgroundColor: isDark ? "#120E1C" : "#F5F3F9",
      borderRadius: 10,
      padding: 14,
      alignItems: "center",
    },
    statNumber: {
      fontSize: 18,
      fontWeight: "700",
      color: isDark ? "#F3F0FF" : "#1E1A29",
      marginBottom: 2,
    },
    statLabel: {
      fontSize: 12,
      color: isDark ? "#7F7A8C" : "#8F8A9E",
    },
    sessionListRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderRadius: 10,
      marginTop: 8,
      backgroundColor: isDark ? "#120E1C" : "#F5F3F9",
    },
    emptySession: {
      color: isDark ? "#7F7A8C" : "#8F8A9E",
      fontSize: 12,
      marginTop: 8,
    },
    liveStatus: {
      color: "#55D6A4",
      fontSize: 11,
      fontWeight: "700",
    },
    downloadButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: isDark ? "rgba(167,139,250,0.12)" : "rgba(109,92,231,0.08)",
    },
    downloadText: {
      color: "#A78BFA",
      fontSize: 10,
      fontWeight: "700",
    },
  });
