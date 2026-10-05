import { createLocalAudioTrack, Room, RoomEvent, Track } from "livekit-client";
import type { ConnectMeeting, MeetingParticipantView } from "./livekitMeeting";

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
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    callbacks.onSpeakingChange?.(speakers.some((participant) => participant.identity === room.localParticipant.identity));
  });
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
      if (message.type === "translation" && message.segment) callbacks.onTranslation?.(message.segment);
      if (message.type === "warning") callbacks.onLiveIssue?.(String(message.message || "Live transcription has a problem; audio is still being saved."));
      if (message.type === "recovered") callbacks.onLiveIssue?.(null);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error("Invalid transcript event"));
    }
  });
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio || options.subscribeAudio === false) return;
    const element = track.attach();
    element.dataset.livekitMeetingAudio = "true";
    document.body.appendChild(element);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((element) => element.remove());
  });

  callbacks.onConnectionChange("connecting");
  if (options.publishMicrophone) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not provide microphone access");
    }
    // Request permission before connecting so the organizer's click is still
    // associated with the browser permission prompt. LiveKit opens its own
    // track immediately afterwards.
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
  }
  await room.connect(url, token);
  await room.startAudio();
  try {
    if (options.publishMicrophone) {
      const microphoneTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.localParticipant.publishTrack(microphoneTrack, {
        source: Track.Source.Microphone,
      });
    } else {
      await room.localParticipant.setMicrophoneEnabled(false);
    }
    if (options.publishMicrophone && ![...room.localParticipant.trackPublications.values()].some((publication) => publication.kind === Track.Kind.Audio)) {
      // A permission prompt can race the first LiveKit publication on some
      // browsers. Retry once before declaring the organizer connected.
      await room.localParticipant.setMicrophoneEnabled(false);
      const retryTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await room.localParticipant.publishTrack(retryTrack, {
        source: Track.Source.Microphone,
      });
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
      if (options.publishMicrophone || options.notifyMicState) {
        const payload = new TextEncoder().encode(JSON.stringify({ type: "mic", identity: room.localParticipant.identity, name: room.localParticipant.name || "Organizer", muted: !enabled }));
        await room.localParticipant.publishData(payload, { reliable: true, topic: "meeting.mic" });
      }
    },
    disconnect: async () => {
      await room.localParticipant.setMicrophoneEnabled(false);
      document.querySelectorAll("[data-livekit-meeting-audio='true']").forEach((element) => element.remove());
      await room.disconnect();
    },
  };
};
