// A sent message read back into the words it quoted and what was asked about
// them, as Repack's chat shows a quote (domain/script-quote.ts). Edit's own
// format (editor.tsx): "Quoted from narration 3 (clip …, characters a–b):\n“…”\n\nrequest",
// or "Quoted from the script:\n“…”\n\nrequest" for a stretch across paragraphs.

export function parseScriptQuotedMessage(text: string) {
  const match = text.match(/^Quoted from (?:narration (\d+) \([^)]*\)|the script):\n“([\s\S]*?)”\n\n([\s\S]*)$/);
  if (!match) return null;
  return { narrationNumber: match[1] ? Number(match[1]) : null, quote: match[2]!, request: match[3]! };
}
