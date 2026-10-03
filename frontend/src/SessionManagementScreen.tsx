import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
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

import { createMeeting, getSessionInfo, getSessionQrUrl } from "./api";
import type { Language, MeetingConnection, SessionInfo } from "./types";

interface SessionManagementScreenProps {
  onJoinSession: (roomCode: string, displayName: string, title?: string) => void;
  onOpenCreatedSession: (connection: MeetingConnection, title: string) => void;
  isDark: boolean;
}

export function SessionManagementScreen({ onJoinSession, onOpenCreatedSession, isDark }: SessionManagementScreenProps) {
  const { width } = useWindowDimensions();
  const isWide = width >= 800;

  const [mode, setMode] = useState<"create" | "join">("create");

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
    info?: SessionInfo;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [refreshingInfo, setRefreshingInfo] = useState(false);

  // Join form state
  const [participantName, setParticipantName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const code = new URLSearchParams(window.location.search).get("session")?.trim().toUpperCase();
    if (code) {
      setMode("join");
      setJoinCode(code);
    }
  }, []);

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
        info,
      });
    } catch (err) {
      Alert.alert("Error Creating Session", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const handleRefreshInfo = async () => {
    if (!activeSession) return;
    setRefreshingInfo(true);
    try {
      const info = await getSessionInfo(activeSession.code);
      setActiveSession((prev: { code: string; title: string; qrUrl: string; info?: SessionInfo } | null) => (prev ? { ...prev, info } : null));
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

  const handleJoinSubmit = async () => {
    if (!participantName.trim()) {
      Alert.alert("Required", "Please enter your display name.");
      return;
    }
    if (!joinCode.trim()) {
      Alert.alert("Required", "Please enter the session QR code or room code.");
      return;
    }

    setJoining(true);
    try {
      // Validate session capacity beforehand if possible
      const cleanCode = joinCode.trim().toUpperCase();
      const info = await getSessionInfo(cleanCode).catch(() => null);

      if (info && info.current_participants >= info.max_participants) {
        Alert.alert(
          "Session Full",
          `This session has reached its limit of ${info.max_participants} participants.`,
        );
        setJoining(false);
        return;
      }

      onJoinSession(cleanCode, participantName.trim(), info?.title);
    } catch (err) {
      Alert.alert("Join Error", err instanceof Error ? err.message : "Could not join session");
    } finally {
      setJoining(false);
    }
  };

  const styles = getStyles(isDark);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>SESSION MANAGEMENT</Text>
        <Text style={styles.title}>Event Sessions & QR Access</Text>
        <Text style={styles.subtitle}>
          Organizers can create managed event sessions with participant caps and automatically generated QR codes.
        </Text>
      </View>

      {/* Mode Switcher */}
      <View style={styles.tabContainer}>
        <Pressable
          style={[styles.tabButton, mode === "create" && styles.tabButtonActive]}
          onPress={() => setMode("create")}
        >
          <Feather name="plus-circle" size={18} color={mode === "create" ? "#A78BFA" : "#8F8A9E"} />
          <Text style={[styles.tabText, mode === "create" && styles.tabTextActive]}>
            Organizer (Create)
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabButton, mode === "join" && styles.tabButtonActive]}
          onPress={() => setMode("join")}
        >
          <Feather name="grid" size={18} color={mode === "join" ? "#A78BFA" : "#8F8A9E"} />
          <Text style={[styles.tabText, mode === "join" && styles.tabTextActive]}>
            Participant (Join)
          </Text>
        </Pressable>
      </View>

      {mode === "create" ? (
        activeSession ? (
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
              </View>
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
      ) : (
        /* Join Session Form */
        <View style={[styles.card, isWide && styles.cardWide]}>
          <Text style={styles.cardHeader}>Join Event Session</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Your Name</Text>
            <TextInput
              style={styles.input}
              value={participantName}
              onChangeText={setParticipantName}
              placeholder="e.g. Alice"
              placeholderTextColor="#625E70"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Session Code (or from QR)</Text>
            <TextInput
              style={styles.input}
              value={joinCode}
              onChangeText={setJoinCode}
              placeholder="e.g. ABC12345"
              autoCapitalize="characters"
              placeholderTextColor="#625E70"
            />
            <Text style={styles.hint}>
              Enter the session room code generated by the event organizer.
            </Text>
          </View>

          <Pressable
            style={styles.primaryButton}
            onPress={handleJoinSubmit}
            disabled={joining}
          >
            {joining ? (
              <ActivityIndicator color="white" />
            ) : (
              <>
                <Feather name="log-in" size={18} color="white" />
                <Text style={styles.primaryButtonText}>Join Session</Text>
              </>
            )}
          </Pressable>
        </View>
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
  });
