import type { Segment } from "./types";

export type MeetingParticipantView = { identity: string; name: string };

export type MeetingCallbacks = {
  onConnectionChange: (status: string) => void;
  onParticipantsChange: (participants: MeetingParticipantView[]) => void;
  onSegment: (segment: Segment) => void;
  onTranslation?: (segment: Segment) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onMicStateChange?: (state: { identity: string; name: string; muted: boolean }) => void;
  onError: (error: Error) => void;
};

export type MeetingConnectOptions = {
  publishMicrophone: boolean;
  /** Host can broadcast mute state while audio uses the secure capture socket. */
  notifyMicState?: boolean;
  /** Attendees receive transcript data only and must not play organizer audio. */
  subscribeAudio?: boolean;
};

export interface MeetingClient {
  disconnect: () => Promise<void>;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
}

export type ConnectMeeting = (
  url: string,
  token: string,
  callbacks: MeetingCallbacks,
  options: MeetingConnectOptions,
) => Promise<MeetingClient>;
