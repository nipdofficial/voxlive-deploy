# VoxLive production audit — 29 October 2026

This is a partial audit, not a release approval or a claim of complete testing.

## Architecture verified in source

- Expo/React Native web frontend; FastAPI backend; Google Gen AI SDK with Vertex credentials; LiveKit meetings.
- Account, authentication-session and transcript history data are persisted in JSON files under `DATA_DIR`; audio is stored on disk. This is not an RDS database.
- Standalone Live and Record stream PCM to `/api/live`. Meetings use LiveKit and a separate meeting audio WebSocket. Upload posts multipart audio to `/api/transcribe`.
- S3 serves the frontend through CloudFront; a separate EC2 instance supplies `/api` through CloudFront. A persistent EBS volume holds application data.
- The configured default is chunk-based Flash transcription, with native Live disabled. The previous config validator rewrote explicitly selected 3.5 transcription models; local changes now allow the documented model IDs without changing production defaults.

## Critical production issue

Unauthenticated production `GET /api/history` returned HTTP 200 on 29 October 2026. The deployed history routes lack explicit ownership checks and the events WebSocket broadcasts record events to unauthenticated clients. Local changes add authenticated owner filtering, administrator-only legacy access, organizer-authenticated audio streams, and participant-scoped attendee transcript access. New invitations use a random secret in the URL fragment and require validation before issuing a room-scoped LiveKit token. Existing links must be regenerated. These changes have not been deployed or independently security-reviewed.

Production CloudFront uses `http-only` to the EC2 custom origin, and that origin's port 80 is reachable from the internet. The direct origin also returned HTTP 200 for anonymous history. Viewer HTTPS therefore does not establish TLS for the CloudFront-to-origin connection. A trusted certificate matching an origin hostname is required for HTTPS. The user stated that they currently do not have a domain and will arrange a domain and DNS. The current VPC has public subnets and no available NAT gateway; a private VPC-origin alternative would require separately authorized network changes and may add charges.

## Model observations

- The configured Vertex project returned model metadata for `gemini-3.5-transcribe`, `gemini-3.5-transcribe-live` and `gemini-3.8-flash`; metadata availability does not establish quality or quota suitability.
- A real `gemini-3.5-transcribe` request for one second of generated silence returned no text.
- A real `gemini-3.5-transcribe-live` connection accepted one second of generated silence and returned no transcription during a 15-second observation window.
- A real Flash translation request for a simple English phrase returned nonempty Tamil-script text. Semantic accuracy was not independently evaluated.
- Google's published live transcription language list does not list Sinhala or Tamil as of the referenced documentation. Do not claim those languages are supported by this model without additional provider confirmation and representative real-audio tests. Live sessions have a documented 10-minute limit.
- References: https://ai.google.dev/gemini-api/docs/live-api/live-transcribe and https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe

## Remaining work

Local HTTP tests exercised two organizers, anonymous access, legacy administrator access, protected downloads, WebSocket authentication, and forged, expired and cross-room attendee tokens. An isolated local server also exercised login, logout and a real LiveKit join with synthetic accounts. A supplied audio recording produced standalone Live source and translation before Stop; a real LiveKit run produced source and Tamil events before session end. In that run, the first source and translation events arrived 19.5 and 25.2 seconds after the test began, including connection setup. A subsequent run instead received a provider timeout warning and no live translation. This is not an acceptable near-real-time reliability guarantee. File processing and standalone Record were exercised with the supplied recording; the source was preserved and requested translation persisted. Digital silence tests of 30 seconds and two minutes produced no standalone live events, and a 30-second digital-silence meeting produced no attendee transcript events. These individual runs do not establish accuracy or production readiness.

Remaining work includes representative Sinhala/Tamil/mixed recordings with reference text, second-device attendee and QR verification, noise/echo and responsiveness tests, end-to-end dashboard and production checks, and independent security review. The user stated that representative recordings and a second-device test are not currently available. The original-language list for Gemini 3.5 Transcribe Live does not list Sinhala or Tamil, and an actual native Live test on the supplied recording returned no recognition events. Do not silently switch the current model. No latency percentile, complete endpoint audit or production readiness has been established.
