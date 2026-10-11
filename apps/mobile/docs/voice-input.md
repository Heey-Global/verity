# Voice input

On iOS, chat and task capture use Apple's on-device SpeechTranscriber through
VerityLiveSTT. There is no alternate recognizer or cloud fallback. An unsupported
device or language shows an error and leaves text entry available. The first use
may need a language-model download. This change requires a native app build;
an OTA update alone cannot add the dictation methods. Android retains its OS
speech recognizer.

Voice input vocabulary settings are available under transcription settings.
The default list contains public project and development terms. Custom terms,
explicit variants, and the correction switch are stored only on the device;
the vocabulary settings are not synchronized or included in diagnostics.
Corrected text becomes ordinary message or task content and is submitted when
the user sends or saves it.

Use one term per line, optionally followed by explicit variants separated by
`|`, for example `GitHub | git hub`. Up to 100 terms of one or two words are
supported. Corrections apply only to finalized speech, before automatic sending,
and never to existing typed text. Complete words and phrases match without case;
longer phrases take precedence, replacements do not cascade, and ambiguous
variants remain unchanged. Addresses and Markdown-marked code are protected.
Unmarked code cannot reliably be distinguished from ordinary dictation.
Correction can be disabled. The default variants normalize recognizable product
spellings; they do not guess phonetic recognition errors.

Vocabulary is also supplied as SpeechAnalyzer contextual strings. Apple's
SpeechTranscriber currently ignores these hints, so this does not train or bias
its model. Local text correction supplies the vocabulary behavior.

Meetings and dictation share native microphone ownership. A competing recording
is rejected. Stopping drains final results; cancelling discards trailing results.
Each dictation has a session identifier so late events cannot alter another input.

## Native verification

Before releasing a native build, test on a supported iPhone:

- First-use permissions and model preparation/download, including cancellation.
- Unsupported language and denied microphone access, with text entry still usable.
- German partial/final results, repeated phrases, microphone levels, and silence stop.
- Stop preserving final text; abort and navigation discarding late events.
- Manual edits, automatic sending of corrected text, and task saving after finalization.
- Vocabulary editing, disabling, persistence across restart, and protected code/addresses.
- Meeting versus chat/task microphone conflicts in both directions, including model preparation.

JavaScript tests use a mocked native bridge and cannot establish recognition
quality, audio-session behavior, or Swift compilation. These require the native
build and device checks above.

## Prepared dictation

Visible chat and task inputs request a single shared, prepared iOS analyzer.
Preparation checks supported locales and installed assets, chooses the analysis
format, and calls Apple's `prepareToAnalyze(in:)`. It does not activate an audio
session, request microphone permission, record audio, or download missing assets.
Missing assets are installed only after an explicit dictation start.

The next recording consumes the prepared analyzer. Stopping or cancelling closes
that session; a fresh analyzer is prepared after teardown while an input remains
eligible. Finished result streams are never reused. Model retention uses
`whileInUse`; preparation is released on background entry, memory warnings,
language changes, and meeting start. Closing the last input retains preparation
for up to 60 seconds. The app does not run a recording or a preparation service
continuously in the iOS background.

Only explicit dictation activates the microphone. Captured buffers are queued
before analyzer startup with a finite limit; overflow reports an error instead of
silently discarding opening words. Preparation and recording readiness have
separate indicators. Initial permissions, missing models, and a cold audio session
can still delay startup. Preheating is an optimization, not an instant-start
guarantee.

For a native Debug build, the Xcode console reports `Dictation timing first-audio`
and `Dictation timing first-result` in milliseconds from the microphone-button
request. These local measurements contain no audio, recognized text, vocabulary,
or locale and are not emitted in Release builds. The first-audio value uses the
capture callback's timestamp; first-result measures the first native transcript,
which may be provisional. Wall-clock changes can invalidate a sample.

Compare at least five cold starts with five prepared starts on the same iPhone,
locale, and audio route. Speak the same German opening phrase immediately after
tapping and verify that its first words survive. Record timing distributions and
device/OS/build information rather than claiming a guaranteed latency reduction.
Also check that:

- Opening an input causes no microphone indicator or permission prompt.
- Stop and abort immediately remove the microphone indicator.
- Repeated starts receive fresh results without earlier-session text.
- Background entry stops dictation and releases preparation; returning can prepare again.
- Closing inputs releases the reserve after the grace period.
- Memory warnings, language changes, and meeting starts release the reserve.
- Meetings and dictation remain mutually exclusive during preparation and teardown.
- Prepared idle memory and energy use are acceptable compared with cold starts.

These checks require a new native build and a supported physical iPhone.
Source guards and mocked bridge tests do not verify Swift compilation or timing.
