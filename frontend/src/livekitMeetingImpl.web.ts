import { Room, RoomEvent, Track } from "livekit-client";
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
  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    if (options.publishMicrophone && publication.kind === Track.Kind.Audio) callbacks.onConnectionChange("microphone ready");
  });
  room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic !== "transcript.segment") return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload));
      if (message.type === "transcript" && message.segment) callbacks.onSegment(message.segment);
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
    await room.localParticipant.setMicrophoneEnabled(options.publishMicrophone);
    if (options.publishMicrophone && ![...room.localParticipant.trackPublications.values()].some((publication) => publication.kind === Track.Kind.Audio)) {
      // A permission prompt can race the first LiveKit publication on some
      // browsers. Retry once before declaring the organizer connected.
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
    },
    disconnect: async () => {
      await room.localParticipant.setMicrophoneEnabled(false);
      document.querySelectorAll("[data-livekit-meeting-audio='true']").forEach((element) => element.remove());
      await room.disconnect();
    },
  };
};
