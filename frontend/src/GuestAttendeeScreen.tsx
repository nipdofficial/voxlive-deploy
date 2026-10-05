import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { Feather } from "@expo/vector-icons";

import { getSessionInfo, getTranscript, joinMeeting, submitMeetingFeedback } from "./api";
import type { MeetingClient, MeetingParticipantView } from "./livekitMeeting";
import type { Segment, SessionInfo } from "./types";

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function sameLiveSegment(left: Segment, right: Segment) {
  if (left.segment_id && right.segment_id) return left.segment_id === right.segment_id;
  return left.participant_identity === right.participant_identity
    && left.start === right.start && left.end === right.end && left.text === right.text;
}

function sortLiveSegments(items: Segment[]) {
  return [...items].sort((left, right) => (right.sequence ?? -1) - (left.sequence ?? -1) || right.start - left.start || right.end - left.end);
}

function upsertLiveSegment(current: Segment[], next: Segment) {
  const index = current.findIndex((item) => sameLiveSegment(item, next));
  if (index < 0) return sortLiveSegments([next, ...current]);
  const updated = [...current];
  updated[index] = { ...updated[index], ...next };
  return sortLiveSegments(updated);
}

export default function GuestAttendeeScreen({ roomCode }: { roomCode: string }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [name, setName] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [participants, setParticipants] = useState<MeetingParticipantView[]>([]);
  const participantsRef = useRef<MeetingParticipantView[]>([]);
  const [client, setClient] = useState<MeetingClient | null>(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hasJoined, setHasJoined] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);

  const styles = useMemo(() => createStyles(), []);
  const joined = Boolean(client);
  const participantView = joined || hasJoined;

  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.documentElement.style.backgroundColor = "#100E14";
      document.body.style.backgroundColor = "#100E14";
    }
  }, []);

  useEffect(() => {
    void getSessionInfo(roomCode).then((session) => {
      setInfo(session);
      setStatus(session.status === "upcoming" ? "upcoming" : session.is_started ? session.is_active ? "ready" : "ended" : "waiting");
    }).catch((caught) => {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "This session is not available");
    });
  }, [roomCode]);

  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(() => () => { void client?.disconnect(); }, [client]);

  // Use the saved, canonical live line as a fallback when a mobile browser
  // misses a room data message. The organizer and every attendee therefore
  // converge on the same Tamil-first line without waiting for meeting end.
  useEffect(() => {
    if (!client || !info?.meeting_id || status === "ended") return;
    let cancelled = false;
    const refreshLiveLines = async () => {
      try {
        const record = await getTranscript(info.meeting_id);
        if (cancelled) return;
        if (record.error) {
          const isCapacity = record.error.includes("429") || record.error.includes("RESOURCE_EXHAUSTED");
          setError(isCapacity
            ? "Live translation is temporarily busy. The organizer is still saving the audio; the final transcript will be retried after the session ends."
            : record.error);
        } else setError(null);
        if (!record.segments.length) return;
        setSegments((current) => record.segments.reduce(
          (items, segment) => upsertLiveSegment(items, segment),
          current,
        ));
      } catch {
        // LiveKit remains the primary transport; keep the attendee connected
        // when a short HTTP refresh is unavailable.
      }
    };
    void refreshLiveLines();
    const timer = setInterval(() => void refreshLiveLines(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, info?.meeting_id, status]);

  // The backend keeps the authoritative meeting transcript. Refresh the
  // attendee copy when the organizer ends the room so both views retain the
  // completed transcript, including any final segments not received live.
  useEffect(() => {
    if (!info || status === "ended" || status === "left") return;
    const timer = setInterval(() => {
      void getSessionInfo(roomCode).then(async (session) => {
        setInfo(session);
        setStatus(session.status === "upcoming" ? "upcoming" : session.is_started ? session.is_active ? (joined ? "connected" : "ready") : "ended" : "waiting");
        if (session.is_started && !session.is_active) {
          setStatus("ended");
          await client?.disconnect();
          setClient(null);
          const record = await getTranscript(session.meeting_id).catch(() => null);
          if (record?.error) setError(record.error);
          if (record?.segments.length) setSegments([...record.segments].sort((left, right) => right.start - left.start));
        }
      }).catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [client, info, joined, roomCode, status]);

  const join = async () => {
    if (!name.trim() || !info?.is_active || !info.is_started) return;
    setError(null);
    setStatus("joining");
    try {
      const connection = await joinMeeting(roomCode, name.trim(), false);
      if (connection.segments?.length) setSegments(sortLiveSegments(connection.segments));
      const { connectMeeting } = await import("helascribe-meeting-connector");
      const nextClient = await connectMeeting(connection.livekit_url, connection.token, {
        onConnectionChange: setStatus,
        onParticipantsChange: (nextParticipants) => {
          participantsRef.current = nextParticipants;
          setParticipants(nextParticipants);
        },
        onSegment: (segment) => setSegments((current) => {
          const speaker = segment.speaker
            || participantsRef.current.find((participant) => participant.identity === segment.participant_identity)?.name
            || segment.participant_identity
            || "Speaker";
          const labeledSegment = { ...segment, speaker };
          return upsertLiveSegment(current, labeledSegment);
        }),
        onTranslation: (segment) => setSegments((current) => upsertLiveSegment(current, segment)),
        onMicStateChange: (state) => setSpeakerMuted(state.muted),
        onError: (caught) => setError(caught.message),
      }, { publishMicrophone: false, subscribeAudio: false });
      setClient(nextClient);
      setHasJoined(true);
      setStartedAt(Date.now());
      setStatus("connected");
    } catch (caught) {
      setStatus("ready");
      setError(caught instanceof Error ? caught.message : "Could not join this session");
    }
  };

  const download = async () => {
    const text = [...segments].sort((left, right) => left.start - right.start).map((segment) => `${segment.speaker || "Speaker"}: ${segment.translated_text || segment.text}`).join("\n");
    if (!text.trim()) return;
    const filename = `voxlive_${roomCode}.txt`;
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }
    const file = new File(Paths.cache, filename);
    file.create({ overwrite: true });
    file.write(text);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { dialogTitle: "Save live transcript", mimeType: "text/plain", UTI: "public.plain-text" });
  };

  const leave = async () => {
    if (info?.meeting_id) {
      const record = await getTranscript(info.meeting_id).catch(() => null);
      if (record?.segments.length) setSegments([...record.segments].sort((left, right) => right.start - left.start));
    }
    await client?.disconnect();
    setClient(null);
    setHasJoined(false);
    setStatus("left");
  };

  const sendFeedback = async () => {
    if (!name.trim() || !info) return;
    try {
      await submitMeetingFeedback(roomCode, name.trim(), feedbackRating, feedbackComment);
      setFeedbackSent(true);
      setFeedbackOpen(false);
      setFeedbackComment("");
    } catch (caught) {
      Alert.alert("Feedback", caught instanceof Error ? caught.message : "Could not submit feedback");
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.glow} />
      <ScrollView contentContainerStyle={[styles.content, participantView && { paddingBottom: 110 }]}>
        <View style={styles.brand}>
          <View style={styles.logo}><Feather name="radio" size={20} color="white" /></View>
          <View><Text style={styles.brandName}>VoxLive</Text><Text style={styles.brandTag}>GUEST LIVE SESSION</Text></View>
        </View>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>QR ATTENDEE ACCESS</Text>
          <Text style={styles.title}>{info?.title ?? "Live session"}</Text>
          <Text style={styles.subtitle}>Room {roomCode}</Text>
          {info?.speaker_name ? <Text style={styles.speakerLabel}>Speaker - {info.speaker_name}</Text> : null}
          <View style={styles.stats}>
            <Text style={styles.stat}>{joined ? "● LIVE" : status.toUpperCase()}</Text>
            <Text style={styles.stat}>{participants.length} connected</Text>
            <Text style={styles.stat}>⏱ {formatTime(elapsed)}</Text>
          </View>
        </View>
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        {!participantView ? (
          <View style={styles.joinCard}>
            <Text style={styles.cardTitle}>Join this live transcript</Text>
            <Text style={styles.cardHint}>Enter your display name to continue.</Text>
            <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor="#81798F" style={styles.input} autoCapitalize="words" />
            <Pressable onPress={() => void join()} disabled={status === "loading" || status === "waiting" || status === "upcoming" || status === "joining" || status === "ended" || !name.trim()} style={[styles.primary, (!name.trim() || status === "waiting" || status === "upcoming" || status === "joining" || status === "ended") && { opacity: 0.5 }]}>
              {status === "joining" ? <ActivityIndicator color="white" /> : <><Feather name="log-in" size={17} color="white" /><Text style={styles.primaryText}>{status === "ended" ? "Session ended" : status === "upcoming" ? "Upcoming meeting" : status === "waiting" ? "Waiting for organizer" : "Join live session"}</Text></>}
            </Pressable>
          </View>
        ) : (
          <>
            {status === "ended" ? <View style={styles.ended}><Feather name="check-circle" size={18} color="#55D6A4" /><View><Text style={styles.endedTitle}>Session ended</Text><Text style={styles.endedText}>The organizer ended this session. Your transcript is saved.</Text></View></View> : null}
            {speakerMuted ? <View style={styles.muted}><Feather name="mic-off" size={16} color="#F3C969" /><Text style={styles.mutedText}>The organizer muted the microphone.</Text></View> : null}
            <View style={styles.transcript}>
              <View style={styles.transcriptHeader}>
                <Text style={styles.cardTitle}>Live transcript</Text>
                <Text style={[styles.live, status === "ended" && { color: "#F3C969" }]}>{status === "ended" ? "● ENDED" : "● LIVE"}</Text>
              </View>
              <ScrollView style={styles.transcriptList} contentContainerStyle={styles.transcriptListContent} nestedScrollEnabled>
                {segments.length ? segments.map((segment, index) => (
                  <View key={`${segment.start}-${index}`} style={styles.line}>
                    <Text style={styles.time}>{formatTime(segment.start)}</Text>
                    <View style={styles.lineBar} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.speaker}>{segment.speaker || "Speaker"}</Text>
                      {segment.translated_text ? <><Text style={styles.translation}>{segment.translated_text}</Text><Text style={styles.text}>{segment.text}</Text></> : <Text style={styles.text}>{segment.text}</Text>}
                    </View>
                  </View>
                )) : <Text style={styles.waiting}>{status === "ended" ? "No transcript was captured for this session." : "Waiting for live speech…"}</Text>}
              </ScrollView>
            </View>
          </>
        )}
      </ScrollView>

      {participantView ? (
        <View style={styles.mobileNav}>
          <Pressable onPress={() => void download()} disabled={!segments.length} style={({ pressed }) => [styles.mobileNavItem, !segments.length && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
            <Feather name="download" size={22} color={!segments.length ? "#777181" : "#B9A7FF"} />
            <Text style={[styles.mobileNavText, segments.length > 0 && styles.mobileNavTextActive]}>Save TXT</Text>
          </Pressable>
          <Pressable onPress={() => setFeedbackOpen(true)} style={({ pressed }) => [styles.mobileNavItem, pressed && { opacity: 0.7 }]}>
            <Feather name="star" size={22} color={feedbackSent ? "#55D6A4" : "#B9A7FF"} />
            <Text style={[styles.mobileNavText, feedbackSent && { color: "#55D6A4" }]}>{feedbackSent ? "Feedback" : "Feedback"}</Text>
          </Pressable>
          {joined ? (
            <Pressable onPress={() => void leave()} style={({ pressed }) => [styles.mobileNavItem, pressed && { opacity: 0.7 }]}>
              <Feather name="log-out" size={22} color="#F38A9B" />
              <Text style={[styles.mobileNavText, { color: "#F38A9B" }]}>Leave</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Modal visible={feedbackOpen} transparent animationType="fade" onRequestClose={() => setFeedbackOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.feedbackCard}>
            <Text style={styles.cardTitle}>Session feedback</Text>
            <Text style={styles.cardHint}>How was this live transcript?</Text>
            <View style={styles.ratingRow}>
              {[1, 2, 3, 4, 5].map((rating) => (
                <Pressable key={rating} onPress={() => setFeedbackRating(rating)} style={[styles.rating, rating <= feedbackRating && styles.ratingSelected]}>
                  <Text style={styles.ratingText}>{rating}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput value={feedbackComment} onChangeText={setFeedbackComment} placeholder="Optional comment" placeholderTextColor="#81798F" style={[styles.input, styles.comment]} multiline />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setFeedbackOpen(false)} style={styles.leave}><Text style={styles.leaveText}>Cancel</Text></Pressable>
              <Pressable onPress={() => void sendFeedback()} style={styles.primary}><Text style={styles.primaryText}>Send feedback</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = () => StyleSheet.create({
  page: { flex: 1, backgroundColor: "#100E14", minHeight: Platform.OS === "web" ? ("100vh" as any) : "100%" },
  glow: { position: "absolute", width: 500, height: 500, borderRadius: 250, top: -260, alignSelf: "center", backgroundColor: "rgba(100,70,170,0.10)" },
  content: { width: "100%", maxWidth: 820, alignSelf: "center", padding: 24, gap: 16, flexGrow: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#755BD0", alignItems: "center", justifyContent: "center" },
  brandName: { color: "#F5F2FA", fontFamily: "DMSans_700Bold", fontSize: 18 },
  brandTag: { color: "#9F7AEA", fontFamily: "DMSans_700Bold", fontSize: 8, letterSpacing: 1.2, marginTop: 2 },
  hero: { padding: 24, borderRadius: 20, backgroundColor: "#1A181E", borderWidth: 1, borderColor: "#302C38" },
  eyebrow: { color: "#8063D1", fontFamily: "DMSans_700Bold", fontSize: 9, letterSpacing: 1.8 },
  title: { color: "#F5F2FA", fontFamily: "DMSans_700Bold", fontSize: 28, marginTop: 8 },
  subtitle: { color: "#ABA4B9", fontFamily: "DMSans_400Regular", fontSize: 12, marginTop: 6 },
  speakerLabel: { color: "#CDBDFF", fontFamily: "DMSans_600SemiBold", fontSize: 12, marginTop: 8 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 18 },
  stat: { color: "#D8CDF8", backgroundColor: "rgba(159,122,234,0.16)", paddingHorizontal: 11, paddingVertical: 8, borderRadius: 11, fontFamily: "DMSans_700Bold", fontSize: 11 },
  joinCard: { padding: 22, borderRadius: 18, backgroundColor: "#18161C", borderWidth: 1, borderColor: "#302C38", gap: 11 },
  cardTitle: { color: "#E5E1ED", fontFamily: "DMSans_700Bold", fontSize: 16 },
  cardHint: { color: "#ABA4B9", fontFamily: "DMSans_400Regular", fontSize: 12 },
  input: { height: 48, borderRadius: 11, borderWidth: 1, borderColor: "#4B4262", backgroundColor: "#25222B", color: "#F5F2FA", fontFamily: "DMSans_400Regular", paddingHorizontal: 14, fontSize: 13 },
  primary: { minHeight: 48, borderRadius: 12, backgroundColor: "#755BD0", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, flex: 1 },
  primaryText: { color: "white", fontFamily: "DMSans_700Bold", fontSize: 13 },
  error: { padding: 13, borderRadius: 11, backgroundColor: "rgba(239,92,117,0.12)" },
  errorText: { color: "#F38A9B", fontFamily: "DMSans_500Medium", fontSize: 12 },
  transcript: { padding: 20, borderRadius: 20, backgroundColor: "#18161C", borderWidth: 1, borderColor: "#302C38", gap: 17 },
  transcriptHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: "#302C38" },
  live: { color: "#55D6A4", fontFamily: "DMSans_700Bold", fontSize: 10 },
  line: { flexDirection: "row", gap: 10 },
  time: { width: 38, color: "#A39BAF", fontFamily: "DMSans_500Medium", fontSize: 10, paddingTop: 2 },
  lineBar: { width: 2, borderRadius: 2, backgroundColor: "#9F7AEA" },
  speaker: { color: "#D8CDF8", fontFamily: "DMSans_700Bold", fontSize: 9, marginBottom: 3, textTransform: "uppercase" },
  text: { color: "#D0CBD9", fontFamily: "DMSans_400Regular", fontSize: 13, lineHeight: 21 },
  translation: { color: "#D8CDF8", fontFamily: "DMSans_400Regular", fontSize: 12, marginTop: 4 },
  waiting: { color: "#A39BAF", fontFamily: "DMSans_400Regular", fontSize: 13, textAlign: "center", paddingVertical: 34 },
  transcriptList: { maxHeight: 520, minHeight: 160 },
  transcriptListContent: { gap: 17, paddingTop: 2 },
  ended: { flexDirection: "row", gap: 10, alignItems: "center", padding: 15, borderRadius: 14, backgroundColor: "rgba(85,214,164,0.10)" },
  endedTitle: { color: "#55D6A4", fontFamily: "DMSans_700Bold", fontSize: 13 },
  endedText: { color: "#ABA4B9", fontFamily: "DMSans_400Regular", fontSize: 11, marginTop: 3 },
  muted: { flexDirection: "row", gap: 8, alignItems: "center", padding: 12, borderRadius: 12, backgroundColor: "rgba(243,201,105,0.10)" },
  mutedText: { color: "#F3C969", fontFamily: "DMSans_500Medium", fontSize: 11 },
  mobileNav: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: Platform.OS === "ios" ? 82 : 68,
    paddingBottom: Platform.OS === "ios" ? 15 : 3,
    borderTopWidth: 1,
    borderTopColor: "#302C38",
    backgroundColor: "rgba(16,14,20,0.92)",
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    zIndex: 10,
  },
  mobileNavItem: { width: 90, alignItems: "center", gap: 2 },
  mobileNavText: { color: "#A39BAF", fontFamily: "DMSans_500Medium", fontSize: 9 },
  mobileNavTextActive: { color: "#D8CDF8" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(7,5,12,0.68)", justifyContent: "center", padding: 22 },
  feedbackCard: { width: "100%", maxWidth: 480, alignSelf: "center", padding: 22, borderRadius: 18, backgroundColor: "#18161C", borderWidth: 1, borderColor: "#302C38", gap: 13 },
  ratingRow: { flexDirection: "row", gap: 8 },
  rating: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#25222B", alignItems: "center", justifyContent: "center" },
  ratingSelected: { backgroundColor: "#755BD0" },
  ratingText: { color: "#F5F2FA", fontFamily: "DMSans_700Bold" },
  comment: { height: 80, paddingTop: 12, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  leave: { minHeight: 44, paddingHorizontal: 16, borderRadius: 11, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(239,92,117,0.12)", flex: 1 },
  leaveText: { color: "#F38A9B", fontFamily: "DMSans_700Bold", fontSize: 12 },
});
