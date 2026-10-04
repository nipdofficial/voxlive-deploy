import { AudioSession, registerGlobals } from "@livekit/react-native";
import { Room, RoomEvent, Track } from "livekit-client";
import type { ConnectMeeting, MeetingParticipantView } from "./livekitMeeting";

registerGlobals();

export const connectMeeting: ConnectMeeting = async (url, token, callbacks, options) => {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const participants = (): MeetingParticipantView[] => [
    { identity: room.localParticipant.identity, name: room.localParticipant.name || room.localParticipant.identity },
    ...[...room.remoteParticipants.values()].map((item) => ({
      identity: item.identity,
      name: item.name || item.identity,
    })),
  ].filter((item) => item.identity);
  const updateParticipants = () => callbacks.onParticipantsChange(participants());

  room.on(RoomEvent.ParticipantConnected, updateParticipants);
  room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
  room.on(RoomEvent.Reconnecting, () => callbacks.onConnectionChange("reconnecting"));
  room.on(RoomEvent.Reconnected, () => callbacks.onConnectionChange("connected"));
  room.on(RoomEvent.Disconnected, () => callbacks.onConnectionChange("disconnected"));
  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    if (options.publishMicrophone && publication.kind === Track.Kind.Audio) callbacks.onConnectionChange("microphone ready");
  });
  room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    try {
      const message = JSON.parse(new TextDecoder().decode(payload));
      if (topic === "meeting.mic" && message.type === "mic") {
        callbacks.onMicStateChange?.({ identity: String(message.identity || "organizer"), name: String(message.name || "Organizer"), muted: Boolean(message.muted) });
        return;
      }
      if (topic !== "transcript.segment") return;
      if (message.type === "transcript" && message.segment) callbacks.onSegment(message.segment);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error("Invalid transcript event"));
    }
  });

  callbacks.onConnectionChange("connecting");
  await AudioSession.startAudioSession();
  await room.connect(url, token);
  try {
    await room.localParticipant.setMicrophoneEnabled(options.publishMicrophone);
    if (options.publishMicrophone && ![...room.localParticipant.trackPublications.values()].some((publication) => publication.kind === Track.Kind.Audio)) {
      // Retry once when Android/iOS finishes the audio session after the room
      // connects. Without this, the UI can say connected while no mic track
      // is published to the transcription worker.
      await room.localParticipant.setMicrophoneEnabled(false);
      await room.localParticipant.setMicrophoneEnabled(true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone permission or publishing failed";
    callbacks.onError(new Error(`Organizer microphone unavailable: ${message}`));
    await room.disconnect();
    throw error;
  }
  callbacks.onConnectionChange("connected");
  updateParticipants();
  return {
    setMicrophoneEnabled: async (enabled: boolean) => {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      if (options.publishMicrophone) {
        const payload = new TextEncoder().encode(JSON.stringify({ type: "mic", identity: room.localParticipant.identity, name: room.localParticipant.name || "Organizer", muted: !enabled }));
        await room.localParticipant.publishData(payload, { reliable: true, topic: "meeting.mic" });
      }
    },
    disconnect: async () => {
      await room.localParticipant.setMicrophoneEnabled(false);
      await room.disconnect();
      await AudioSession.stopAudioSession();
    },
  };
};
