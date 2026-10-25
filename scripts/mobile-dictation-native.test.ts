import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('native Apple dictation preparation', () => {
  it('captures opening audio before waiting for analyzer startup', () => {
    const source = readFileSync('apps/mobile/native/VerityLiveSTT.swift', 'utf8');
    const method = source.slice(
      source.indexOf('private func startAppleMicrophone('),
      source.indexOf('private func emitAppleResult('),
    );
    const capture = method.indexOf('try startMicrophone');
    const startup = method.indexOf('await analyzer.start(');
    // Starting the analyzer first silently discards speech during its startup.
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(startup).toBeGreaterThan(capture);
    expect(method.slice(startup)).toMatch(/try ensureActive\(generation\)/);
  });

  it('checks ownership after format negotiation before replacing the audio stream', () => {
    const source = readFileSync('apps/mobile/native/VerityLiveSTT.swift', 'utf8');
    const method = source.slice(
      source.indexOf('private func startAppleMicrophone('),
      source.indexOf('private func emitAppleResult('),
    );
    const negotiation = method.indexOf('await SpeechAnalyzer.bestAvailableAudioFormat(');
    const streamMutation = method.indexOf('analyzerInput = continuation');
    expect(negotiation).toBeGreaterThanOrEqual(0);
    expect(streamMutation).toBeGreaterThan(negotiation);
    // A cancelled preparation can otherwise overwrite the next recording's stream.
    expect(method.slice(negotiation, streamMutation)).toMatch(/try ensureActive\(generation\)/);
  });
});

function nativeMethod(source: string, name: string) {
  const start = source.indexOf('func ' + name + '(');
  expect(start, name).toBeGreaterThanOrEqual(0);
  const opening = source.indexOf('{', start);
  let depth = 1;
  let end = opening + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  return source.slice(start, end);
}

describe('native prepared dictation lifecycle guards', () => {
  const read = () => readFileSync('apps/mobile/native/VerityLiveSTT.swift', 'utf8');

  it('never reaches microphone activation, permission prompts or downloads during preparation', () => {
    const source = read();
    const methods = [...source.matchAll(/func (\w+)\(/g)].map((match) => match[1]!);
    const visited = new Set<string>();
    function reachable(name: string): string {
      if (visited.has(name)) return '';
      visited.add(name);
      const body = nativeMethod(source, name);
      return (
        body +
        methods
          .filter((other) => new RegExp('\\b' + other + '\\(').test(body))
          .map(reachable)
          .join('\n')
      );
    }
    const preparation = reachable('prepareDictation');
    // A seemingly harmless warm-up must not silently record or download a model.
    expect(preparation).not.toMatch(
      /requestRecordPermission|setActive\(true\)|installTap|startMicrophone\(|downloadAndInstall|assetInstallationRequest/,
    );
    expect(preparation).toContain('prepareToAnalyze(in: format)');
    expect(preparation).toContain('== .installed');
    expect(preparation).toContain('modelRetention: .whileInUse');
  });

  it('invalidates pending preparations and only takes a matching current session', () => {
    const source = read();
    const discard = nativeMethod(source, 'discardPreparation');
    expect(discard).toContain('preparationGeneration += 1');
    expect(discard).toContain('preparationTask?.cancel()');
    expect(discard).toContain('prepared = nil');
    const take = nativeMethod(source, 'takePreparedDictation');
    expect(take).toContain('preparationLocale != locale');
    const waiting = take.indexOf('await pending.value');
    expect(waiting).toBeGreaterThanOrEqual(0);
    // A cancelled warm-up must not consume a replacement session after an await.
    expect(take.slice(waiting)).toMatch(
      /ensureActive\(generation\)[\s\S]*preparationGeneration == epoch[\s\S]*discardPreparation\(\)/,
    );
  });

  it('starts a fresh preparation only after teardown and keeps meetings exclusive', () => {
    const source = read();
    expect(nativeMethod(source, 'start')).toContain('if owner == nil { discardPreparation() }');
    for (const method of ['stop', 'finishDictation', 'failCapture']) {
      const body = nativeMethod(source, method);
      expect(body).toContain('defer { if activeEngine == nil { prepareNextDictation() } }');
      expect(body).toContain('stopMicrophone()');
    }
    expect(nativeMethod(source, 'prepareDictation')).toContain('activeEngine == nil');
    expect(source).toContain('UIApplication.didEnterBackgroundNotification');
    expect(source).toContain('UIApplication.didReceiveMemoryWarningNotification');
    expect(nativeMethod(source, 'startAppleMicrophone')).toContain('.bufferingOldest(128)');
    expect(nativeMethod(source, 'startAppleMicrophone')).toContain('case .dropped');
  });
});
