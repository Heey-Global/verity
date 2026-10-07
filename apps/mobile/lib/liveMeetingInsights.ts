export function latestResearchQuestion(transcript: string): string | null {
  const recent = transcript.slice(-1600);
  const questions = recent.match(/[^.!?\n]{8,240}\?/g);
  return questions?.at(-1)?.trim() ?? null;
}

function recentContext(transcript: string): string {
  return transcript.trim().slice(-1600);
}

export function meetingRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function researchPrompt(
  meetingId: string,
  question: string,
  transcript: string,
  requestId?: string,
): string {
  return [
    `Research this point raised during live meeting ${meetingId}:`,
    question,
    `Recent meeting transcript:\n${recentContext(transcript)}`,
    'Use reliable sources. Summarize what is established, cite sources, and state any uncertainty.',
    ...(requestId ? [`Meeting request reference: ${requestId}`] : []),
  ].join('\n\n');
}

export function meetingRequestPrompt(
  meetingId: string,
  request: string,
  transcript: string,
  requestId?: string,
): string {
  return [
    `During live meeting ${meetingId}, please respond to this request:`,
    request,
    `Recent meeting transcript:\n${recentContext(transcript)}`,
    ...(requestId ? [`Meeting request reference: ${requestId}`] : []),
  ].join('\n\n');
}
