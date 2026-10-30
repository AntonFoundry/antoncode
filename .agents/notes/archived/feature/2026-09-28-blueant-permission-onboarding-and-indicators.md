# Agent Note: Blueant permission onboarding and voice controls

Status: implemented
Archived: 2026-10-30

English

## Problem

Anton requested system permissions independently and did not guide the user through the order needed for global key monitoring, paste-at-cursor, and screen capture. Ad-hoc app signing also changed the code identity across rebuilds, so macOS could discard prior TCC grants. The centered wake indicator used particles and expanding circles instead of the referenced glass sphere and compact prismatic waveform.

## Decision

`AntonApp` checks Input Monitoring, Accessibility, and Screen Recording in order at launch. It requests the first permission macOS has not granted, waits while the user changes System Settings, and checks again on app activation and once per second. It advances only after the current grant is visible to the corresponding preflight API; a help alert after 12 seconds opens the matching Privacy & Security pane. A new process checks TCC again and skips permissions macOS already granted.

`RightOptionPushToTalk` observes Right Option through local and global flags-changed monitors only while Input Monitoring is granted. Press starts local dictation without showing the Blueant panel; release stops it, pastes the transcript into the previously focused app, and restores the clipboard contents. The accessibility and screen-capture grants are checked through macOS APIs, not read from TCC storage.

The centered orb is a 136-point dark glass sphere inside a 380-point transparent panel. Its moving white-hot waveform core uses amber, magenta, cyan, and blue layers and responds to the existing microphone-level and frequency-band input. It has no particle field or expanding ring graphics.

`scripts/build-anton-macos.ts` uses the `ANTON_CODESIGN_IDENTITY` environment variable for the app, bridge, and bundled Node runtime. When unset, the build keeps its local ad-hoc signature and uses an identifier-only designated requirement. A stable Apple Development identity lets TCC match the app across rebuilds; the ad-hoc fallback does not promise that macOS will retain grants.

## Alternatives considered

**Request every permission at once.** Rejected because concurrent system prompts overlap and the user cannot know which grant unlocks the next capability.

**Remember completed onboarding steps in Anton settings.** Rejected because TCC is authoritative and can revoke a grant independently; every launch checks actual system state instead.

**Keep ad-hoc signing as the only build path.** Rejected because its changing code signature can invalidate TCC grants. Ad-hoc signing remains the fallback for machines without a configured Apple Development identity.

**Retain particles and visible rings around the orb.** Rejected because the reference uses one compact luminous waveform inside a glass sphere, with no decorative particles or ring outlines.

## Consequences

If a permission stays disabled, Anton waits at that step and does not open later permission prompts. The help alert provides a direct link to the relevant System Settings pane, and returning to Anton resumes the check. Screen Recording changes that require a process relaunch are recognized on the next launch.

Right Option dictation does not activate Blueant or replace the frontmost app. It temporarily uses the general pasteboard and restores its prior data after posting Command-V; clipboard managers may observe that short-lived replacement.

The build preserves TCC grants only when `ANTON_CODESIGN_IDENTITY` names an installed, stable signing identity. A machine without one continues to use ad-hoc signing and may need to grant permissions again after a rebuild.

The orb uses the microphone level and spectrum delivered by the voice path. Screen Recording permission supports existing desktop capture features; this note does not claim that the orb distorts pixels behind its window.
