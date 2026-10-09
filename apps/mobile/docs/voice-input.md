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
