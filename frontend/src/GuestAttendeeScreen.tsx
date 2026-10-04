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
    void getSessionInfo(roomCode).then((session) => {
      setInfo(session);
      setStatus(session.is_started ? session.is_active ? "ready" : "ended" : "waiting");
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

  // The backend keeps the authoritative meeting transcript. Refresh the
  // attendee copy when the organizer ends the room so both views retain the
  // completed transcript, including any final segments not received live.
  useEffect(() => {
    if (!info || status === "ended" || status === "left") return;
    const timer = setInterval(() => {
      void getSessionInfo(roomCode).then(async (session) => {
        setInfo(session);
        setStatus(session.is_started ? session.is_active ? (joined ? "connected" : "ready") : "ended" : "waiting");
        if (session.is_started && !session.is_active) {
          setStatus("ended");
          await client?.disconnect();
          setClient(null);
          const record = await getTranscript(session.meeting_id).catch(() => null);
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
          const duplicate = current.some((item) => item.participant_identity === labeledSegment.participant_identity && item.start === labeledSegment.start && item.end === labeledSegment.end && item.text === labeledSegment.text);
          return duplicate ? current : [labeledSegment, ...current].sort((left, right) => right.start - left.start);
        }),
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
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.brand}><View style={styles.logo}><Feather name="radio" size={20} color="white" /></View><View><Text style={styles.brandName}>VoxLive</Text><Text style={styles.brandTag}>GUEST LIVE SESSION</Text></View></View>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>QR ATTENDEE ACCESS</Text>
          <Text style={styles.title}>{info?.title ?? "Live session"}</Text>
          <Text style={styles.subtitle}>Room {roomCode}</Text>
          <View style={styles.stats}><Text style={styles.stat}>{joined ? "● LIVE" : status.toUpperCase()}</Text><Text style={styles.stat}>{participants.length} connected</Text><Text style={styles.stat}>⏱ {formatTime(elapsed)}</Text></View>
        </View>
        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
        {!participantView ? (
          <View style={styles.joinCard}>
            <Text style={styles.cardTitle}>Join this live transcript</Text>
            <Text style={styles.cardHint}>Enter your display name to continue.</Text>
            <TextInput value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor="#81798F" style={styles.input} autoCapitalize="words" />
            <Pressable onPress={() => void join()} disabled={status === "loading" || status === "waiting" || status === "joining" || status === "ended" || !name.trim()} style={[styles.primary, (!name.trim() || status === "waiting" || status === "joining" || status === "ended") && { opacity: 0.5 }]}>{status === "joining" ? <ActivityIndicator color="white" /> : <><Feather name="log-in" size={17} color="white" /><Text style={styles.primaryText}>{status === "ended" ? "Session ended" : status === "waiting" ? "Waiting for organizer" : "Join live session"}</Text></>}</Pressable>
          </View>
        ) : (
          <>
            {status === "ended" ? <View style={styles.ended}><Feather name="check-circle" size={18} color="#55D6A4" /><View><Text style={styles.endedTitle}>Session ended</Text><Text style={styles.endedText}>The organizer ended this session. Your transcript is saved.</Text></View></View> : null}
            {speakerMuted ? <View style={styles.muted}><Feather name="mic-off" size={16} color="#F3C969" /><Text style={styles.mutedText}>The organizer muted the microphone.</Text></View> : null}
            <View style={styles.actions}><Pressable onPress={() => void download()} disabled={!segments.length} style={[styles.action, !segments.length && { opacity: 0.5 }]}><Feather name="download" size={16} color="#CDBDFF" /><Text style={styles.actionText}>Save TXT</Text></Pressable><Pressable onPress={() => setFeedbackOpen(true)} style={styles.action}><Feather name="star" size={16} color="#CDBDFF" /><Text style={styles.actionText}>{feedbackSent ? "Feedback sent" : "Feedback"}</Text></Pressable>{joined ? <Pressable onPress={() => void leave()} style={styles.leave}><Text style={styles.leaveText}>Leave</Text></Pressable> : null}</View>
            <View style={styles.transcript}><View style={styles.transcriptHeader}><Text style={styles.cardTitle}>Live transcript</Text><Text style={[styles.live, status === "ended" && { color: "#F3C969" }]}>{status === "ended" ? "● ENDED" : "● LIVE"}</Text></View><ScrollView style={styles.transcriptList} contentContainerStyle={styles.transcriptListContent} nestedScrollEnabled>{segments.length ? segments.map((segment, index) => <View key={`${segment.start}-${index}`} style={styles.line}><Text style={styles.time}>{formatTime(segment.start)}</Text><View style={styles.lineBar} /><View style={{ flex: 1 }}><Text style={styles.speaker}>{segment.speaker || "Speaker"}</Text>{segment.translated_text ? <><Text style={styles.translation}>{segment.translated_text}</Text><Text style={styles.text}>{segment.text}</Text></> : <Text style={styles.text}>{segment.text}</Text>}</View></View>) : <Text style={styles.waiting}>Waiting for live speech…</Text>}</ScrollView></View>
          </>
        )}
      </ScrollView>
      <Modal visible={feedbackOpen} transparent animationType="fade" onRequestClose={() => setFeedbackOpen(false)}><View style={styles.modalBackdrop}><View style={styles.feedbackCard}><Text style={styles.cardTitle}>Session feedback</Text><Text style={styles.cardHint}>How was this live transcript?</Text><View style={styles.ratingRow}>{[1, 2, 3, 4, 5].map((rating) => <Pressable key={rating} onPress={() => setFeedbackRating(rating)} style={[styles.rating, rating <= feedbackRating && styles.ratingSelected]}><Text style={styles.ratingText}>{rating}</Text></Pressable>)}</View><TextInput value={feedbackComment} onChangeText={setFeedbackComment} placeholder="Optional comment" placeholderTextColor="#81798F" style={[styles.input, styles.comment]} multiline /><View style={styles.actions}><Pressable onPress={() => setFeedbackOpen(false)} style={styles.leave}><Text style={styles.leaveText}>Cancel</Text></Pressable><Pressable onPress={() => void sendFeedback()} style={styles.primary}><Text style={styles.primaryText}>Send feedback</Text></Pressable></View></View></View></Modal>
    </View>
  );
}

const createStyles = () => StyleSheet.create({
  page: { flex: 1, backgroundColor: "#100D16" }, glow: { position: "absolute", width: 500, height: 500, borderRadius: 250, top: -260, alignSelf: "center", backgroundColor: "rgba(117,91,208,0.16)" }, content: { width: "100%", maxWidth: 820, alignSelf: "center", padding: 24, gap: 16 }, brand: { flexDirection: "row", alignItems: "center", gap: 10 }, logo: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#755BD0", alignItems: "center", justifyContent: "center" }, brandName: { color: "#F1ECFF", fontSize: 18, fontWeight: "700" }, brandTag: { color: "#9F7AEA", fontSize: 8, letterSpacing: 1.2, marginTop: 2 }, hero: { padding: 24, borderRadius: 22, backgroundColor: "#211B32", borderWidth: 1, borderColor: "#4B4262" }, eyebrow: { color: "#B9A7FF", fontSize: 9, fontWeight: "700", letterSpacing: 1.5 }, title: { color: "#F1ECFF", fontSize: 28, fontWeight: "700", marginTop: 8 }, subtitle: { color: "#B8B1C8", fontSize: 12, marginTop: 6 }, stats: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 18 }, stat: { color: "#D1C0FF", backgroundColor: "rgba(159,122,234,0.16)", paddingHorizontal: 11, paddingVertical: 8, borderRadius: 11, fontSize: 11, fontWeight: "700" }, joinCard: { padding: 22, borderRadius: 18, backgroundColor: "#191620", borderWidth: 1, borderColor: "#302C38", gap: 11 }, cardTitle: { color: "#EEEAF9", fontSize: 16, fontWeight: "700" }, cardHint: { color: "#9F98AA", fontSize: 12 }, input: { height: 48, borderRadius: 11, borderWidth: 1, borderColor: "#4B4262", backgroundColor: "#25222B", color: "#F1ECFF", paddingHorizontal: 14, fontSize: 13 }, primary: { minHeight: 48, borderRadius: 12, backgroundColor: "#755BD0", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }, primaryText: { color: "white", fontSize: 13, fontWeight: "700" }, error: { padding: 13, borderRadius: 11, backgroundColor: "rgba(239,92,117,0.12)" }, errorText: { color: "#F38A9B", fontSize: 12 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 9 }, action: { minHeight: 42, paddingHorizontal: 14, borderRadius: 11, backgroundColor: "#2A2338", flexDirection: "row", alignItems: "center", gap: 7 }, actionText: { color: "#CDBDFF", fontSize: 11, fontWeight: "700" }, leave: { minHeight: 42, paddingHorizontal: 14, borderRadius: 11, justifyContent: "center", backgroundColor: "rgba(239,92,117,0.12)" }, leaveText: { color: "#F38A9B", fontSize: 11, fontWeight: "700" }, transcript: { padding: 20, borderRadius: 18, backgroundColor: "#191620", borderWidth: 1, borderColor: "#302C38", gap: 17 }, transcriptHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: "#302C38" }, live: { color: "#55D6A4", fontSize: 10, fontWeight: "700" }, line: { flexDirection: "row", gap: 10 }, time: { width: 38, color: "#8F8A9E", fontSize: 10, paddingTop: 2 }, lineBar: { width: 2, borderRadius: 2, backgroundColor: "#9F7AEA" }, speaker: { color: "#B9A7FF", fontSize: 9, fontWeight: "700", marginBottom: 3 }, text: { color: "#E0DAEA", fontSize: 14, lineHeight: 21 }, translation: { color: "#B9A7FF", fontSize: 12, marginTop: 4 }, waiting: { color: "#8F8A9E", fontSize: 13, textAlign: "center", paddingVertical: 34 },
  transcriptList: { maxHeight: 520, minHeight: 160 }, transcriptListContent: { gap: 17, paddingTop: 2 }, ended: { flexDirection: "row", gap: 10, alignItems: "center", padding: 15, borderRadius: 14, backgroundColor: "rgba(85,214,164,0.10)" }, endedTitle: { color: "#55D6A4", fontWeight: "700", fontSize: 13 }, endedText: { color: "#B8B1C8", fontSize: 11, marginTop: 3 }, muted: { flexDirection: "row", gap: 8, alignItems: "center", padding: 12, borderRadius: 12, backgroundColor: "rgba(243,201,105,0.10)" }, mutedText: { color: "#F3C969", fontSize: 11 }, modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "center", padding: 22 }, feedbackCard: { width: "100%", maxWidth: 480, alignSelf: "center", padding: 22, borderRadius: 18, backgroundColor: "#211B32", gap: 13 }, ratingRow: { flexDirection: "row", gap: 8 }, rating: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#302A40", alignItems: "center", justifyContent: "center" }, ratingSelected: { backgroundColor: "#755BD0" }, ratingText: { color: "#F1ECFF", fontWeight: "700" }, comment: { height: 80, paddingTop: 12, textAlignVertical: "top" },
});
