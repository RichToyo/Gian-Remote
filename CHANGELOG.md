# Gian Remote Changelog

## [1.4.2] - 2026-10-22

- Offline deployment works across classic Docker and containerd image stores,
  which can expose different immutable IDs for the same saved image. New
  schema-3 receipts distinguish the build daemon ID, config digest and OCI
  manifest digest, with their links verified directly from the single-image
  archive before deployment.
- Apply resolves only an archive-bound local image, verifies its platform,
  source, layers and migrations before stopping the service, and uses that
  immutable ID for startup, backup, health checks and retries. Ambiguous or
  unsupported archives fail closed without registry pulls or tag fallbacks.
- Existing 1.4.1 release assets remain immutable; this compatibility fix is
  delivered as a new release, not replacement metadata for an older archive.

## [1.4.1] - 2026-10-22

- Remote Web shows Working as soon as the Host confirms an active turn,
  without waiting for a tool event or refreshing the page. Completed turns,
  pending approvals, unavailable history and disconnected state no longer
  present stale model activity; final replies continue to arrive live.
- Release CI publishes tested native amd64/arm64 offline image archives,
  source-bound deployment tooling and verified release metadata. The local
  download/upload CLI needs no Docker on the operator's Mac and preserves
  existing SSH configuration. Server deployment no longer pulls from a registry.
- Publication and deployment are separate steps. Upload stages verified files
  without restarting the service; explicit apply preserves the existing project,
  data volume, stopped-data backups and migration-aware cached-image rollback.
- Continues to use Remote Protocol 1.4.0 and a compatible Gian Host; no new
  protocol version or database migration is required.

## [1.4.0] - Unreleased

- Publishes from RichToyo/Gian-Remote with English-only product copy.
- Requires the separately published Remote Protocol 1.4.0 package and a
  compatible Gian Host; source preparation does not deploy either component.

- Conversation translation sync (requires a Gian Host with
  `wire.conversation_translation`; older Hosts keep plain chat): the Auto
  translate chip mirrors the local switch both ways in real time, sent and
  reading translations render under the original message (real-time, history
  pages, refresh and reconnect), the globe toggle expands/collapses per view, and
  automatic sending translates first with the same 45s timeout / retry /
  send-original / take-text-back gate as local Gian. Translation executes on
  the paired Host with its saved settings; the browser and Remote Server
  never see Agent or model configuration.
- The send gate restores an interrupted draft into the composer after a
  refresh instead of resending it.

## [1.3.0] - 2026-10-19

- Remote Web follows the Host's configured interface language (English or
  Simplified Chinese) once the connection negotiates `wire.host_locale`; Hosts running
  older Gian versions keep the previous English interface.
- Transcript rendering corrects bold text adjacent to CJK characters.
- GitHub device-flow sign-in survives upstream interruptions: temporary
  GitHub failures return a retryable 503 with `Retry-After` and the poll
  backs off (RFC 8628) instead of revoking the in-progress authorization.
- Requires `@gian/remote-protocol` 1.3.0 (published by public Gian); no
  database migration.

## [1.2.4] - 2026-09-25

- Reduces the mobile context-usage ring to a compact 20px indicator while
  keeping it beside the model control and preserving button touch targets.

## [1.2.3] - 2026-09-25

- Makes the five mobile composer controls visually consistent while retaining
  touch-friendly button targets.
- Moves the context-usage ring next to the model control on Remote Web.

## [1.2.0] - 2026-09-23

- Adds a separate Host registration page at `/enrollment`. Deployment-configured
  GitHub account allowlisting controls enrollment token generation.
- Enrollment tokens are account-bound, single-use and expire after five minutes.
  The command-line administrator path remains available with the same restrictions.
- Browser remote control no longer requires GitHub login. Pairing still needs
  explicit approval on the Host, device-key authentication and end-to-end encryption.
  Browser delegation lasts thirty days and can be revoked; expiry requires pairing again.
- Supports native Gian remote execution with same-account admission, history
  replication, scoped file preview and updated model/configuration controls.

### Upgrade Notes

- Configure `GIAN_REMOTE_GITHUB_CLIENT_ID` and `GIAN_REMOTE_ENROLLMENT_GITHUB_IDS`.
  An empty allowlist denies new Host registrations.
- Existing unbound Host registrations and unused enrollment tokens are not
  implicitly trusted. Compatible Gian clients must complete GitHub authorization
  and register again. Ordinary reconnects after registration do not need a new token.
- The App GitHub credential is not forwarded to a self-hosted Server. Native
  Remote authorization remains separate from the App login.
