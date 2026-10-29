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
import { LinearGradient } from "expo-linear-gradient";

import { createMeeting, deleteManagedMeeting, getManagedMeetingHistory, getManagedMeetings, getSessionInfo, getSessionQrUrl, resumeOrganizerMeeting } from "./api";
import type { Language, MeetingConnection, SessionInfo, SessionType, TranscriptRecord } from "./types";
import { SchedulePicker, todayLocal } from "./SchedulePicker";

function joinUrlFor(roomCode: string, invitation: string | null | undefined): string {
  if (!invitation) throw new Error("The session invitation is unavailable. Reopen the session and try again.");
  return `${typeof window !== "undefined" ? window.location.origin : "https://d39saojiwcdxjz.cloudfront.net"}/?session=${encodeURIComponent(roomCode.trim().toUpperCase())}#invite=${encodeURIComponent(invitation)}`;
}

async function buildJoinQr(roomCode: string, invitation: string | null | undefined): Promise<string> {
  const joinUrl = joinUrlFor(roomCode, invitation);
  if (Platform.OS !== "web") return getSessionQrUrl(roomCode);
  const qr = await import("qrcode");
  return qr.toDataURL(joinUrl, { width: 320, margin: 2, errorCorrectionLevel: "M" });
}

interface SessionManagementScreenProps {
  onOpenCreatedSession: (connection: MeetingConnection, title: string, mode?: Exclude<SessionType, "Meeting">) => Promise<void>;
  onStartCreatedSession: (connection: MeetingConnection, title: string, mode?: Exclude<SessionType, "Meeting">) => Promise<void>;
  isDark: boolean;
  authToken: string;
}

export function SessionManagementScreen({ onOpenCreatedSession, onStartCreatedSession, isDark, authToken }: SessionManagementScreenProps) {
  const { width } = useWindowDimensions();
  const isWide = width >= 800;
  const isDesktop = width >= 1024;
  const isMobile = width < 600;

  // Create form state
  const [organizerName, setOrganizerName] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("50");
  const [language, setLanguage] = useState<Language>("Mixed");
  const [preferredSpeakerLanguage, setPreferredSpeakerLanguage] = useState<Language>("Sinhala");
  const [scheduleMode, setScheduleMode] = useState<"now" | "scheduled">("now");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reminderMinutes, setReminderMinutes] = useState(15);
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
  const [managedSessions, setManagedSessions] = useState<SessionInfo[]>([]);
  const [starting, setStarting] = useState(false);

  const scheduleBrowserReminder = (session: SessionInfo | undefined) => {
    if (Platform.OS !== "web" || !session?.scheduled_start || typeof window === "undefined" || !("Notification" in window)) return;
    const start = new Date(session.scheduled_start).getTime();
    const delay = start - Date.now() - reminderMinutes * 60_000;
    if (delay <= 0 || delay > 2_147_000_000) return;
    window.setTimeout(() => {
      if (Notification.permission === "granted") new Notification(`VoxLive reminder: ${session.title}`, { body: `Your session starts ${reminderMinutes} minutes from now.` });
    }, delay);
  };

  const requestReminderPermission = async () => {
    if (Platform.OS === "web" && typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  };

  useEffect(() => {
    const refresh = () => {
      void getManagedMeetingHistory(authToken).then(setPastSessions).catch(() => undefined);
      void getManagedMeetings(authToken).then(setManagedSessions).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [authToken]);

  const downloadTranscript = async (record: TranscriptRecord) => {
    const contents = record.segments.length
      ? record.segments.map((segment) => `${segment.speaker || "Speaker"}: ${segment.translated_text || segment.text}`).join("\n")
      : record.transcript.trim();
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
      let scheduledStart: string | undefined;
      let scheduledEnd: string | undefined;
      if (scheduleMode === "scheduled") {
        if (!startDate || !startTime || !endTime) throw new Error("Choose a date, start time, and end time.");
        const startsAt = new Date(`${startDate}T${startTime}:00`);
        const endsAt = new Date(`${startDate}T${endTime}:00`);
        if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error("Choose a valid date and time.");
        if (startsAt <= new Date()) throw new Error("Choose a future start time.");
        if (endsAt <= startsAt) throw new Error("End time must be later than start time on the selected date.");
        scheduledStart = startsAt.toISOString();
        scheduledEnd = endsAt.toISOString();
      }
      const conn = await createMeeting(
        organizerName.trim(),
        language,
        false,
        sessionTitle.trim() || "Event Session",
        parsedLimit,
        scheduledStart,
        scheduledEnd,
        authToken,
        language === "Mixed" ? preferredSpeakerLanguage : undefined,
      );

      const qrUrl = await buildJoinQr(conn.room_code, conn.invitation_secret);
      const info = await getSessionInfo(conn.room_code).catch(() => undefined);
      await requestReminderPermission();
      scheduleBrowserReminder(info);

      setActiveSession({
        code: conn.room_code,
        title: sessionTitle.trim() || "Event Session",
        qrUrl,
        connection: conn,
        joinUrl: joinUrlFor(conn.room_code, conn.invitation_secret),
        info,
      });
      void getManagedMeetings(authToken).then(setManagedSessions).catch(() => undefined);
    } catch (err) {
      Alert.alert("Error Creating Session", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteSession = (session: SessionInfo) => {
    const remove = async () => {
      try {
        await deleteManagedMeeting(session.room_code, authToken);
        if (activeSession?.code === session.room_code) setActiveSession(null);
        setManagedSessions((items) => items.filter((item) => item.room_code !== session.room_code));
        void getManagedMeetingHistory(authToken).then(setPastSessions).catch(() => undefined);
      } catch (error) {
        Alert.alert("Could not delete session", error instanceof Error ? error.message : "Please try again");
      }
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Delete “${session.title}”? This cannot be undone.`)) void remove();
    } else {
      Alert.alert("Delete session", `Delete “${session.title}”? This cannot be undone.`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void remove() }]);
    }
  };

  const openManagedSession = async (session: SessionInfo, showQr = false, modeOverride?: Exclude<SessionType, "Meeting">) => {
    if (starting) return;
    setStarting(true);
    try {
      const connection = await resumeOrganizerMeeting(session.room_code, authToken);
      const selectedMode = modeOverride ?? session.start_mode ?? "Live";
      if (showQr) {
        setActiveSession({
          code: session.room_code,
          title: session.title,
          qrUrl: await buildJoinQr(session.room_code, connection.invitation_secret),
          connection,
          joinUrl: joinUrlFor(session.room_code, connection.invitation_secret),
          info: session,
        });
      } else if (session.status === "live") {
        await onOpenCreatedSession(connection, session.title, selectedMode);
      } else {
        await onStartCreatedSession(connection, session.title, selectedMode);
      }
    } catch (error) {
      Alert.alert("Could not open session", error instanceof Error ? error.message : "Please try again");
      void getManagedMeetings(authToken).then(setManagedSessions).catch(() => undefined);
    } finally {
      setStarting(false);
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
  const completedSessions = pastSessions
    .filter((record) => record.session_type === "Meeting" && (record.status === "completed" || record.status === "failed"))
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  const activeStatus = activeSession?.info?.status ?? (activeSession?.info?.is_active ? "live" : "ready");
  const statusLabel = activeStatus === "live" ? "LIVE NOW" : activeStatus === "upcoming" ? "UPCOMING" : activeStatus === "ended" ? "ENDED" : "READY TO START";
  const currentMeetingId = activeSession?.info?.meeting_id;
  const savedLiveSessions = managedSessions
    .filter((session) => session.status === "live" && session.meeting_id !== currentMeetingId)
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  const savedUpcomingSessions = managedSessions
    .filter((session) => !session.is_started && session.meeting_id !== currentMeetingId)
    .sort((left, right) => new Date(left.scheduled_start || left.created_at).getTime() - new Date(right.scheduled_start || right.created_at).getTime());
  const scheduledStartTime = activeSession?.info?.scheduled_start
    ? new Date(activeSession.info.scheduled_start).getTime()
    : null;
  const waitingForSchedule = activeStatus === "upcoming" && scheduledStartTime !== null && scheduledStartTime > Date.now();
  // Opening the organizer setup is safe for upcoming rooms; the actual start
  // endpoint enforces the scheduled time.
  const canChooseStartMode = activeStatus !== "ended";

  return (
    <ScrollView contentContainerStyle={[styles.container, isMobile && styles.containerMobile]}>
      <LinearGradient colors={isDark ? ["#241D3A", "#171421"] : ["#F3EEFF", "#FFFFFF"]} start={[0, 0]} end={[1, 1]} style={[styles.hero, isMobile && styles.heroMobile]}>
        <View style={styles.heroGlow} />
        <View style={styles.heroContent}>
          <View style={styles.headerIcon}><Feather name="calendar" size={19} color="#FFFFFF" /></View>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>WORKSPACE / SESSIONS</Text>
            <Text style={[styles.title, isMobile && styles.titleMobile]}>Manage Your Sessions</Text>
            <Text style={styles.subtitle}>Create, organize, and manage your VoxLive events in one place.</Text>
          </View>
          {!isMobile ? <View style={styles.heroMeta}><View style={styles.heroMetaDot} /><Text style={styles.heroMetaText}>Workspace ready</Text></View> : null}
        </View>
      </LinearGradient>

      <View style={styles.overviewGrid}>
        <View style={[styles.overviewCard, styles.liveOverview]}><View style={[styles.overviewIcon, { backgroundColor: "rgba(85,214,164,0.18)" }]}><Feather name="radio" size={16} color="#55D6A4" /></View><View><Text style={styles.overviewValue}>{managedSessions.filter((session) => session.status === "live").length}</Text><Text style={styles.overviewLabel}>Live now</Text></View><Feather style={styles.overviewArrow} name="activity" size={16} color="#55D6A4" /></View>
        <View style={styles.overviewCard}><View style={[styles.overviewIcon, { backgroundColor: "rgba(167,139,250,0.18)" }]}><Feather name="archive" size={16} color="#A78BFA" /></View><View><Text style={styles.overviewValue}>{completedSessions.length}</Text><Text style={styles.overviewLabel}>Saved Sessions</Text></View><Feather style={styles.overviewArrow} name="bar-chart-2" size={16} color="#A78BFA" /></View>
        <View style={styles.overviewCard}><View style={[styles.overviewIcon, { backgroundColor: "rgba(243,201,105,0.18)" }]}><Feather name="calendar" size={16} color="#F3C969" /></View><View><Text style={styles.overviewValue}>{managedSessions.filter((session) => !session.is_started).length}</Text><Text style={styles.overviewLabel}>Upcoming</Text></View><Feather style={styles.overviewArrow} name="clock" size={16} color="#F3C969" /></View>
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
                {activeSession.info?.speaker_name ? <Text style={styles.speakerLabel}>Speaker - {activeSession.info.speaker_name}</Text> : null}
                {activeSession.info?.scheduled_start ? <Text style={styles.speakerLabel}>Scheduled {new Date(activeSession.info.scheduled_start).toLocaleString()} – {activeSession.info.scheduled_end ? new Date(activeSession.info.scheduled_end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</Text> : null}
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
                  source={{ uri: activeSession.qrUrl, headers: Platform.OS === "web" ? undefined : { Authorization: `Bearer ${authToken}` } }}
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
                    {statusLabel}
                  </Text>
                  <Text style={styles.statLabel}>Status</Text>
                </View>
              </View>
            ) : null}

            {activeStatus !== "ended" ? <Pressable
              style={[styles.primaryButton, { marginTop: 24 }, starting && { opacity: 0.6 }]}
              disabled={starting || !canChooseStartMode}
              onPress={() => {
                if (activeSession.info) void openManagedSession(activeSession.info, false);
                else {
                  setStarting(true);
                  const action = activeStatus === "live" ? onOpenCreatedSession : onStartCreatedSession;
                  void action(activeSession.connection, activeSession.title)
                    .catch((error) => Alert.alert("Could not open meeting", error instanceof Error ? error.message : "Please try again"))
                    .finally(() => setStarting(false));
                }
              }}
            >
              {starting ? <ActivityIndicator color="white" /> : <Feather name={activeStatus === "live" ? "mic" : "sliders"} size={18} color="white" />}
              <Text style={styles.primaryButtonText}>{activeStatus === "live"
                ? "Enter Organizer Room"
                : waitingForSchedule && scheduledStartTime
                  ? `Configure upcoming session · starts ${new Date(scheduledStartTime).toLocaleString()}`
                  : "Continue to choose mode"}</Text>
            </Pressable> : <View style={styles.endedBanner}><Feather name="check-circle" size={17} color="#55D6A4" /><Text style={styles.endedBannerText}>Meeting ended. This room is closed.</Text></View>}

            <Pressable
              style={styles.textButton}
              onPress={() => {
                setActiveSession(null);
                setSessionTitle("");
                setScheduleMode("now");
                setStartDate("");
                setStartTime("");
                setEndTime("");
              }}
            >
              <Text style={styles.textButtonText}>Create Another Session</Text>
            </Pressable>

            {activeSession.info && !activeSession.info.is_started ? <Pressable style={styles.deleteButton} onPress={() => handleDeleteSession(activeSession.info!)}><Feather name="trash-2" size={16} color="#F28B9A" /><Text style={styles.deleteButtonText}>Delete scheduled session</Text></Pressable> : null}
          </View>
        ) : (
          /* Create Session Form */
          <View style={[styles.card, styles.createCard, isWide && styles.cardWide]}>
            <View style={styles.createHeader}>
              <View style={styles.createHeaderIcon}><Feather name="plus" size={18} color="#CDBDFF" /></View>
              <View style={{ flex: 1 }}><Text style={styles.cardHeader}>Create New Event Session</Text><Text style={styles.cardDescription}>Set up the room details now. Choose Record, Live, or Upload when you enter the organizer workspace.</Text></View>
            </View>

            <View style={[styles.formGrid, !isDesktop && styles.formGridStack]}>
              <View style={styles.formPanel}>
                <Text style={styles.panelEyebrow}>SESSION DETAILS</Text>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Organizer Display Name</Text>
                  <TextInput
                    accessibilityLabel="Organizer display name"
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
                    accessibilityLabel="Session or event title"
                    style={styles.input}
                    value={sessionTitle}
                    onChangeText={setSessionTitle}
                    placeholder="e.g. Keynote Presentation 2026"
                    placeholderTextColor="#625E70"
                  />
                </View>

                <View style={[styles.fieldGroup, styles.fieldGroupLast]}>
                  <Text style={styles.label}>Maximum Participants</Text>
                  <TextInput
                    accessibilityLabel="Maximum participants"
                    style={styles.input}
                    value={maxParticipants}
                    onChangeText={setMaxParticipants}
                    placeholder="50"
                    keyboardType="number-pad"
                    placeholderTextColor="#625E70"
                  />
                  <Text style={styles.hint}>Limits how many participants can join this session simultaneously.</Text>
                </View>
              </View>

              <View style={styles.formPanel}>
                <Text style={styles.panelEyebrow}>LANGUAGE & TIMING</Text>
                <View style={styles.fieldGroup}>
              <Text style={styles.label}>Speaker input language</Text>
              <View style={styles.optionRow}>
                {(["Sinhala", "Mixed"] as Language[]).map((option) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: language === option }} key={option} onPress={() => setLanguage(option)} style={[styles.choiceCard, language === option && styles.choiceCardActive]}><Feather name={option === "Sinhala" ? "message-circle" : "globe"} size={15} color={language === option ? "#FFFFFF" : "#A78BFA"} /><Text style={[styles.choiceText, language === option && styles.choiceTextActive]}>{option}</Text>{language === option ? <Feather name="check" size={14} color="#FFFFFF" /> : null}</Pressable>)}
              </View>
              <Text style={styles.hint}>Choose one language for better live recognition, or use Mixed for automatic detection.</Text>
              {language === "Mixed" ? <>
                <Text style={[styles.label, { marginTop: 14 }]}>Main speaker language</Text>
                <View style={styles.segmentRow}>
                  {(["Sinhala", "Tamil", "English"] as Language[]).map((option) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: preferredSpeakerLanguage === option }} key={option} onPress={() => setPreferredSpeakerLanguage(option)} style={[styles.segmentOption, preferredSpeakerLanguage === option && styles.segmentOptionActive]}><Text style={[styles.segmentText, preferredSpeakerLanguage === option && styles.choiceTextActive]}>{option}</Text></Pressable>)}
                </View>
                <Text style={styles.hint}>Gemini prioritizes this language while still detecting every language spoken and translating every line to Tamil.</Text>
              </> : null}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Meeting timing</Text>
              <View style={styles.segmentRow}>
                {(["now", "scheduled"] as const).map((option) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: scheduleMode === option }} key={option} onPress={() => setScheduleMode(option)} style={[styles.segmentOption, scheduleMode === option && styles.segmentOptionActive]}><Feather name={option === "now" ? "zap" : "calendar"} size={14} color={scheduleMode === option ? "#FFFFFF" : "#A78BFA"} /><Text style={[styles.segmentText, scheduleMode === option && styles.choiceTextActive]}>{option === "now" ? "Meeting now" : "Schedule meeting"}</Text></Pressable>)}
              </View>
              {scheduleMode === "scheduled" ? <>
                <View style={styles.scheduleFields}>
                  <SchedulePicker kind="date" label="Meeting date" value={startDate} onChange={setStartDate} min={todayLocal()} isDark={isDark} />
                  <SchedulePicker kind="time" label="Start time" value={startTime} onChange={setStartTime} isDark={isDark} />
                  <SchedulePicker kind="time" label="End time" value={endTime} onChange={setEndTime} isDark={isDark} />
                </View>
                <Text style={styles.hint}>Times use your device’s local time. Meetings appear under Upcoming until started.</Text>
                <Text style={[styles.label, { marginTop: 14 }]}>Reminder notification</Text>
                <View style={styles.reminderRow}>
                  {[5, 15, 30].map((minutes) => <Pressable key={minutes} onPress={() => setReminderMinutes(minutes)} style={[styles.reminderOption, reminderMinutes === minutes && styles.reminderOptionActive]}><Feather name="bell" size={13} color={reminderMinutes === minutes ? "white" : "#A78BFA"} /><Text style={[styles.reminderText, reminderMinutes === minutes && { color: "white" }]}>{minutes} min before</Text></Pressable>)}
                </View>
              </> : <Text style={styles.hint}>Create the room and QR now. Choose Record, Live, or Upload on the organizer start screen.</Text>}
                </View>
              </View>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Generate session and QR code"
              style={[styles.primaryButton, styles.createButton, creating && styles.buttonDisabled]}
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
      }

      <View style={[styles.card, styles.controlCard]}>
        <View style={styles.controlHeader}><View><Text style={styles.cardHeader}>Your sessions</Text><Text style={styles.hint}>Return to any meeting you created, or download a completed transcript.</Text></View><View style={styles.allSessionsBadge}><Feather name="layers" size={13} color="#CDBDFF" /><Text style={styles.allSessionsText}>{completedSessions.length + managedSessions.length} total</Text></View></View>
        <View style={styles.sectionHeading}><View style={styles.sectionDot} /><Text style={styles.sectionTitle}>LIVE NOW</Text><Text style={styles.sectionCount}>{savedLiveSessions.length + (activeStatus === "live" ? 1 : 0)}</Text></View>
        {activeStatus === "live" && activeSession?.info ? <View style={[styles.sessionListRow, styles.liveRow]}><View style={styles.sessionRowIcon}><Feather name="radio" size={16} color="#55D6A4" /></View><View style={{ flex: 1 }}><Text style={styles.sessionTitle}>{activeSession.title}</Text><Text style={styles.sessionCodeLabel}>Speaker - {activeSession.info.speaker_name || "Organizer"} · {activeSession.info.current_participants} connected</Text></View><View style={styles.livePill}><View style={styles.livePillDot} /><Text style={styles.livePillText}>LIVE</Text></View></View> : null}
        {savedLiveSessions.map((session) => <View key={session.meeting_id} style={[styles.sessionListRow, styles.liveRow]}><View style={styles.sessionRowIcon}><Feather name="radio" size={16} color="#55D6A4" /></View><View style={{ flex: 1 }}><Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text><Text style={styles.sessionCodeLabel}>Speaker - {session.speaker_name || "Organizer"} · Room {session.room_code}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`Open ${session.title}`} disabled={starting} onPress={() => void openManagedSession(session)} style={styles.rowAction}><Text style={styles.rowActionText}>Open</Text></Pressable></View>)}
        {!savedLiveSessions.length && activeStatus !== "live" ? <View style={styles.emptyState}><Feather name="radio" size={18} color="#70697D" /><Text style={styles.emptySession}>No live sessions</Text></View> : null}
        <View style={[styles.sectionHeading, { marginTop: 24 }]}><View style={[styles.sectionDot, { backgroundColor: "#A78BFA" }]} /><Text style={styles.sectionTitle}>UPCOMING & READY</Text><Text style={styles.sectionCount}>{savedUpcomingSessions.length + (activeSession && activeStatus !== "live" && activeStatus !== "ended" ? 1 : 0)}</Text></View>
        {activeSession?.info && activeStatus !== "live" && activeStatus !== "ended" ? <View style={styles.sessionListRow}><View style={styles.sessionRowIcon}><Feather name="calendar" size={16} color="#A78BFA" /></View><View style={{ flex: 1 }}><Text numberOfLines={1} style={styles.sessionTitle}>{activeSession.title}</Text><Text style={styles.sessionCodeLabel}>Speaker - {activeSession.info.speaker_name || "Organizer"} · {activeSession.info.scheduled_start ? `${new Date(activeSession.info.scheduled_start).toLocaleString()}–${activeSession.info.scheduled_end ? new Date(activeSession.info.scheduled_end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}` : "Ready whenever you are"}</Text></View><View style={styles.upcomingPill}><Text style={styles.upcomingPillText}>{activeStatus === "upcoming" ? "UPCOMING" : "READY"}</Text></View></View> : null}
        {savedUpcomingSessions.map((session) => {
          const canStart = session.status !== "upcoming";
          return <View key={session.meeting_id} style={[styles.sessionListRow, !isWide && { flexWrap: "wrap" }]}>
            <View style={styles.sessionRowIcon}><Feather name="calendar" size={16} color="#A78BFA" /></View>
            <View style={{ flex: 1, minWidth: 150 }}>
              <Text numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
              <Text style={styles.sessionCodeLabel}>Speaker - {session.speaker_name || "Organizer"} · Room {session.room_code}</Text>
              <Text style={styles.sessionCodeLabel}>{session.scheduled_start ? `${new Date(session.scheduled_start).toLocaleString()} – ${session.scheduled_end ? new Date(session.scheduled_end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}` : "Ready whenever you are"}</Text>
            </View>
            <View style={styles.rowActions}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Show QR for ${session.title}`} disabled={starting} onPress={() => void openManagedSession(session, true)} style={styles.rowSecondaryAction}><Feather name="grid" size={14} color="#CDBDFF" /><Text style={styles.rowSecondaryText}>QR</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`${canStart ? "Start" : "Prepare"} ${session.title}`} disabled={starting || Boolean(session.scheduled_start && new Date(session.scheduled_start).getTime() > Date.now())} onPress={() => void openManagedSession(session)} style={[styles.rowAction, Boolean(session.scheduled_start && new Date(session.scheduled_start).getTime() > Date.now()) && { opacity: 0.45 }]}><Text style={styles.rowActionText}>{session.scheduled_start && new Date(session.scheduled_start).getTime() > Date.now() ? "Scheduled" : canStart ? "Start" : "Prepare"}</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${session.title}`} disabled={starting} onPress={() => handleDeleteSession(session)} style={styles.deleteIconButton}><Feather name="trash-2" size={15} color="#F28B9A" /></Pressable>
            </View>
          </View>;
        })}
        {!savedUpcomingSessions.length && (!activeSession || activeStatus === "live" || activeStatus === "ended") ? <View style={styles.emptyState}><Feather name="calendar" size={18} color="#70697D" /><Text style={styles.emptySession}>No upcoming sessions scheduled</Text></View> : null}
        <View style={[styles.sectionHeading, { marginTop: 24 }]}><View style={[styles.sectionDot, { backgroundColor: "#F3C969" }]} /><Text style={styles.sectionTitle}>PAST SESSIONS</Text><Text style={styles.sectionCount}>{completedSessions.length}</Text></View>
        {completedSessions.length ? completedSessions.map((record) => { const hasTranscript = Boolean(record.segments.length || record.transcript.trim()); return <View key={record.id} style={styles.sessionListRow}><View style={styles.sessionRowIcon}><Feather name="file-text" size={16} color="#A78BFA" /></View><View style={{ flex: 1 }}><Text numberOfLines={1} style={styles.sessionTitle}>{record.title}</Text><Text style={styles.sessionCodeLabel}>{record.language} · {record.status} · {new Date(record.created_at).toLocaleDateString()}</Text></View><Pressable onPress={() => void downloadTranscript(record)} disabled={!hasTranscript} style={[styles.downloadButton, !hasTranscript && { opacity: 0.45 }]}><Feather name="download" size={15} color="#CDBDFF" /><Text style={styles.downloadText}>TXT</Text></Pressable></View>; }) : <View style={styles.emptyState}><Feather name="archive" size={18} color="#70697D" /><Text style={styles.emptySession}>Completed sessions will appear here</Text></View>}
      </View>
    </ScrollView>
  );
}

const getStyles = (isDark: boolean) =>
  StyleSheet.create({
    container: {
      padding: 28,
      paddingTop: 28,
      paddingBottom: 56,
      alignItems: "center",
      maxWidth: 1440,
      alignSelf: "center",
      width: "100%",
    },
    containerMobile: { padding: 14, paddingTop: 18, paddingBottom: 36 },
    hero: { width: "100%", maxWidth: 1384, minHeight: 138, borderRadius: 20, paddingHorizontal: 26, paddingVertical: 24, overflow: "hidden", borderWidth: 1, borderColor: isDark ? "rgba(205,189,255,0.17)" : "rgba(109,92,231,0.16)", marginBottom: 14, shadowColor: "#000", shadowOffset: { width: 0, height: 10 }, shadowOpacity: isDark ? 0.22 : 0.07, shadowRadius: 22, elevation: 4 },
    heroMobile: { minHeight: 0, paddingHorizontal: 18, paddingVertical: 20, borderRadius: 17 },
    heroGlow: { position: "absolute", width: 210, height: 210, borderRadius: 105, right: -48, top: -92, backgroundColor: "rgba(167,139,250,0.16)" },
    heroContent: { flexDirection: "row", alignItems: "center", gap: 16, width: "100%" },
    heroCopy: { flex: 1, minWidth: 0 },
    header: {
      alignItems: "center",
      marginBottom: 24,
      textAlign: "center",
    },
    headerIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#765CE6", borderWidth: 1, borderColor: "rgba(255,255,255,0.22)", shadowColor: "#765CE6", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 12, elevation: 3 },
    eyebrow: {
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 1.5,
      color: "#A78BFA",
      marginBottom: 5,
    },
    title: {
      fontSize: 27,
      fontWeight: "800",
      color: isDark ? "#F3F0FF" : "#1E1A29",
      marginBottom: 5,
      letterSpacing: -0.45,
    },
    titleMobile: { fontSize: 22 },
    subtitle: {
      fontSize: 14,
      color: isDark ? "#A09AAB" : "#645E73",
      maxWidth: 660,
      lineHeight: 20,
      textAlign: "left",
    },
    heroMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: "auto", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: "rgba(205,189,255,0.18)", backgroundColor: "rgba(255,255,255,0.04)" },
    heroMetaDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#55D6A4" },
    heroMetaText: { color: isDark ? "#D7D1E8" : "#62558A", fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
    overviewGrid: { width: "100%", flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 14 },
    overviewCard: { flex: 1, minWidth: 190, minHeight: 76, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 15, backgroundColor: isDark ? "#1B1725" : "#FFFFFF", borderWidth: 1, borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)", shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: isDark ? 0.14 : 0.04, shadowRadius: 10, elevation: 2 },
    liveOverview: { borderColor: "rgba(85,214,164,0.35)" },
    overviewArrow: { marginLeft: "auto", opacity: 0.7 },
    overviewIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
    overviewValue: { color: isDark ? "#F3F0FF" : "#1E1A29", fontSize: 19, fontWeight: "800" },
    overviewLabel: { color: isDark ? "#9690A3" : "#71697D", fontSize: 11, marginTop: 2 },
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
      backgroundColor: isDark ? "#1B1725" : "#FFFFFF",
      borderRadius: 18,
      padding: 24,
      borderWidth: 1,
      borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: isDark ? 0.13 : 0.04,
      shadowRadius: 18,
      elevation: 2,
    },
    cardWide: {
      maxWidth: 1384,
    },
    createCard: { padding: 0, overflow: "hidden" },
    createHeader: { flexDirection: "row", alignItems: "flex-start", gap: 13, paddingHorizontal: 24, paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)" },
    createHeaderIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: isDark ? "rgba(126,92,230,0.16)" : "#EEE9FC", borderWidth: 1, borderColor: isDark ? "rgba(167,139,250,0.25)" : "rgba(109,92,231,0.16)" },
    cardDescription: { color: isDark ? "#8F899D" : "#71697D", fontSize: 12, lineHeight: 18, marginTop: 3 },
    formGrid: { flexDirection: "row", alignItems: "flex-start", gap: 16, padding: 20 },
    formGridStack: { flexDirection: "column" },
    formPanel: { flex: 1, width: "100%", minWidth: 0, padding: 18, borderRadius: 14, backgroundColor: isDark ? "#15111D" : "#F8F6FC", borderWidth: 1, borderColor: isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)" },
    panelEyebrow: { color: isDark ? "#8F82B4" : "#715EA3", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 16 },
    optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    choiceCard: { flex: 1, minWidth: 120, minHeight: 42, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)", backgroundColor: isDark ? "rgba(255,255,255,0.035)" : "#FFFFFF" },
    choiceCardActive: { backgroundColor: "#6F55D9", borderColor: "#8E78ED" },
    choiceText: { flex: 1, color: isDark ? "#B8B1C8" : "#5E566D", fontSize: 12, fontWeight: "700" },
    choiceTextActive: { color: "#FFFFFF" },
    segmentRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    segmentOption: { flex: 1, minWidth: 88, minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 9, borderWidth: 1, borderColor: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)", backgroundColor: isDark ? "rgba(255,255,255,0.035)" : "#FFFFFF" },
    segmentOptionActive: { backgroundColor: "#6F55D9", borderColor: "#8E78ED" },
    segmentText: { color: isDark ? "#B8B1C8" : "#5E566D", fontSize: 11, fontWeight: "700", textAlign: "center" },
    createButton: { marginHorizontal: 20, marginTop: 0, marginBottom: 20, minHeight: 50, borderRadius: 12, shadowColor: "#6D5CE7", shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.24, shadowRadius: 14, elevation: 4 },
    buttonDisabled: { opacity: 0.58 },
    controlCard: { maxWidth: 1384, marginTop: 14, padding: 24 },
    controlHeader: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 },
    allSessionsBadge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9, backgroundColor: isDark ? "#2A2338" : "#F0EBF8" },
    allSessionsText: { color: isDark ? "#CDBDFF" : "#62499A", fontSize: 11, fontWeight: "700" },
    cardHeader: {
      fontSize: 18,
      fontWeight: "700",
      color: isDark ? "#F3F0FF" : "#1E1A29",
      marginBottom: 0,
    },
    fieldGroup: {
      marginBottom: 18,
    },
    fieldGroupLast: { marginBottom: 0 },
    scheduleFields: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 12 },
    label: {
      fontSize: 13,
      fontWeight: "600",
      color: isDark ? "#C4C0D0" : "#4A4557",
      marginBottom: 6,
    },
    input: {
      backgroundColor: isDark ? "#120E1C" : "#F5F3F9",
      minHeight: 46,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: isDark ? "#F3F0FF" : "#1E1A29",
      borderWidth: 1,
      borderColor: isDark ? "rgba(255,255,255,0.11)" : "rgba(0,0,0,0.10)",
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
      backgroundColor: "#6F55D9",
      borderRadius: 11,
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
      flex: 1,
      minWidth: 150,
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
    deleteButton: { marginTop: 12, minHeight: 42, borderRadius: 10, borderWidth: 1, borderColor: "rgba(242,139,154,0.28)", backgroundColor: "rgba(242,139,154,0.08)", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
    deleteButtonText: { color: "#F28B9A", fontSize: 13, fontWeight: "700" },
    reminderRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    reminderOption: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 9, borderWidth: 1, borderColor: "rgba(167,139,250,0.28)", backgroundColor: "rgba(167,139,250,0.08)" },
    reminderOptionActive: { backgroundColor: "#755BD0", borderColor: "#8067CE" },
    reminderText: { color: "#B8B1C8", fontSize: 11, fontWeight: "600" },
    sessionHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 20,
    },
    sessionTitle: {
      fontSize: 14,
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
    speakerLabel: { fontSize: 12, color: isDark ? "#CDBDFF" : "#62499A", marginTop: 7, fontWeight: "600" },
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
      flexWrap: "wrap",
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
      minHeight: 64,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 12,
      marginTop: 8,
      backgroundColor: isDark ? "#15111D" : "#F7F5FA",
      borderWidth: 1,
      borderColor: isDark ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.055)",
    },
    rowActions: { flexDirection: "row", gap: 7, alignItems: "center", marginLeft: "auto" },
    rowAction: { minHeight: 36, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#6D5CE7", alignItems: "center", justifyContent: "center" },
    rowActionText: { color: "white", fontSize: 12, fontWeight: "700" },
    rowSecondaryAction: { minHeight: 36, paddingHorizontal: 10, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: isDark ? "#2A2338" : "#E9E2F6" },
    rowSecondaryText: { color: isDark ? "#CDBDFF" : "#62499A", fontSize: 12, fontWeight: "700" },
    deleteIconButton: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(242,139,154,0.10)", borderWidth: 1, borderColor: "rgba(242,139,154,0.22)" },
    liveRow: { borderWidth: 1, borderColor: "rgba(85,214,164,0.30)", backgroundColor: isDark ? "rgba(85,214,164,0.07)" : "#F1FBF7" },
    sessionRowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: isDark ? "#2A2338" : "#ECE7F6" },
    sectionHeading: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, marginBottom: 2 },
    sectionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#55D6A4" },
    sectionTitle: { color: isDark ? "#BDB6CB" : "#5E566D", fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
    sectionCount: { marginLeft: "auto", color: isDark ? "#827B91" : "#8F8A9E", fontSize: 11 },
    livePill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 8, backgroundColor: "rgba(85,214,164,0.14)" },
    livePillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#55D6A4" },
    livePillText: { color: "#55D6A4", fontSize: 10, fontWeight: "800" },
    upcomingPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 8, backgroundColor: "rgba(167,139,250,0.14)" },
    upcomingPillText: { color: "#A78BFA", fontSize: 10, fontWeight: "800" },
    endedBanner: { marginTop: 24, padding: 14, borderRadius: 10, backgroundColor: "rgba(85,214,164,0.10)", flexDirection: "row", alignItems: "center", gap: 9 },
    endedBannerText: { color: "#55D6A4", fontSize: 12, fontWeight: "600" },
    emptyState: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 64, marginTop: 8, paddingHorizontal: 14, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: isDark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.09)" },
    emptySession: {
      color: isDark ? "#7F7A8C" : "#8F8A9E",
      fontSize: 12,
      marginTop: 0,
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
