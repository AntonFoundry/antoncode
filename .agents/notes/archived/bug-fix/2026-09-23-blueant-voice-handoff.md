# Agent Note: Blueant voice handoff

Status: implemented
Archived: 2026-10-30

English

## Problem

The wake listener and Gemini Live session were separate lifecycles. A slow bridge could leave wake disabled after the startup retry limit, speech immediately after the wake phrase could be lost, and audio buffered during Gemini setup could arrive out of order. Gemini could converse but had no path to the Anton agent for tools or saved context. Voice exchanges were absent from the journal.

## Decision

The local Whisper listener remains responsible for wake detection. It passes its trailing audio window to the Gemini Live microphone session, which starts shortly after the wake listener releases the input device. While wake listening is enabled, the Mac app prepares a Gemini socket without opening another microphone tap. The bridge buffers outgoing messages in one ordered queue until setup completes. A completed local transcript can retry a silent Gemini audio turn as text on the same Live session.

Gemini owns audible answers. Its `delegate_task` call sends a specific task to the Blueant Harness preset; the tool result returns to Gemini to be spoken. The text popup continues to use local dictation and the Harness text stream. Completed voice transcripts join the daily journal, recent voice exchanges enter a new Gemini session's prompt, and journal triage can store durable voice facts in c0ntext. Kimi subscription access errors select the configured Z.ai triage fallback.

## Alternatives considered

**Send every wake transcript directly to the Harness.** This produces a text agent answer, which cannot preserve Gemini's native speech conversation or its audio turn context.

**Let both local recognition and Gemini answer every turn.** That can create duplicate responses. Local recognition is a diagnostic and a delayed retry only when Gemini has produced no response audio.

**Run the task agent for every spoken question.** This adds tool latency to ordinary conversation. Gemini delegates only when tools or older context are needed.

## Consequences

Preconnecting consumes a Live WebSocket while wake listening is on, though no microphone audio is sent before wake. A completed voice exchange is stored when journaling is enabled. Delegate calls depend on Harness health and have a bounded wait. Provider audio still needs a spoken test on the user's microphone and speakers after installation; keyless tests cover setup ordering, audio forwarding, delegation frames, and journal persistence.
