/** Adapted from pi-fabric's deterministic compaction projection (render.ts). */
import { clipUtf8, MAX_SUMMARY_BYTES, utf8Bytes } from "./bounds.ts";
import type { Sections } from "./projections.ts";

const SECTION_ORDER: { key: keyof Sections; header: string; maxBytes: number }[] = [
  { key: "goal", header: "[Session Goal]", maxBytes: 4096 },
  { key: "files", header: "[Files And Changes]", maxBytes: 4608 },
  { key: "activity", header: "[Fabric Activity]", maxBytes: 2048 },
  { key: "outstanding", header: "[Outstanding Context]", maxBytes: 4608 },
  { key: "earlierTurns", header: "[Earlier Turns]", maxBytes: 3072 },
  { key: "status", header: "[Current Status]", maxBytes: 2048 },
];

const REQUEST_MAX_BYTES = 3072;
const TRANSCRIPT_MAX_BYTES = 5120;
const FOOTER_MAX_BYTES = 1536;
const MAX_INPUT_LINES_PER_SECTION = 128;
const MAX_RENDERED_LINE_BYTES = 1024;

export interface RenderOptions {
  firstEntryId: string;
  lastEntryId: string;
  lastTimestamp: string;
  requestLines?: string[];
  summaryKind?: "compaction" | "branch";
  maxBytes?: number;
}

const POINTER_LINE =
  "For exact pre-summary history, use session_search (or session_event_search within this session) to recall the cited range, then session_event_read by entry seq for exact data.";

const sampledLines = (lines: readonly string[], keep: number): string[] => {
  if (lines.length <= keep) return [...lines];
  const earliest = Math.ceil(keep / 2);
  const latest = Math.floor(keep / 2);
  return [
    ...lines.slice(0, earliest),
    `… omitted ${lines.length - keep} rendered lines`,
    ...lines.slice(lines.length - latest),
  ];
};

const boundedBlock = (header: string, sourceLines: readonly string[], maxBytes: number): string => {
  const clipped = sourceLines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  const capped = sampledLines(clipped, Math.min(clipped.length, MAX_INPUT_LINES_PER_SECTION));
  for (let keep = capped.length; keep >= 1; keep--) {
    const lines = sampledLines(capped, keep);
    const block = [header, ...lines].join("\n");
    if (utf8Bytes(block) <= maxBytes) return block;
  }
  const headerBytes = utf8Bytes(header) + 1;
  const latest = capped.at(-1);
  if (latest !== undefined && maxBytes > headerBytes) {
    return `${header}\n${clipUtf8(latest, maxBytes - headerBytes)}`;
  }
  return clipUtf8(header, maxBytes);
};

export const renderSummary = (sections: Sections, options: RenderOptions): string => {
  const limit = Math.max(1, Math.min(MAX_SUMMARY_BYTES, options.maxBytes ?? MAX_SUMMARY_BYTES));
  const scaled = (header: string, budget: number): number =>
    Math.max(utf8Bytes(header), Math.floor(budget * limit / MAX_SUMMARY_BYTES));
  const blocks: string[] = [];
  for (const { key, header, maxBytes } of SECTION_ORDER) {
    const sectionLines = sections[key];
    if (sectionLines.length === 0) continue;
    blocks.push(boundedBlock(header, sectionLines, scaled(header, maxBytes)));
    if (key === "goal" && options.requestLines && options.requestLines.length > 0) {
      blocks.push(boundedBlock("[Compaction Request]", options.requestLines, scaled("[Compaction Request]", REQUEST_MAX_BYTES)));
    }
  }
  if (sections.goal.length === 0 && options.requestLines && options.requestLines.length > 0) {
    blocks.unshift(boundedBlock("[Compaction Request]", options.requestLines, scaled("[Compaction Request]", REQUEST_MAX_BYTES)));
  }
  if (sections.transcript.length > 0) {
    blocks.push(boundedBlock("---", sections.transcript, scaled("---", TRANSCRIPT_MAX_BYTES)));
  }
  const timestamp = options.lastTimestamp || "(unknown time)";
  const range = options.firstEntryId || options.lastEntryId
    ? `${options.firstEntryId || "(start)"} → ${options.lastEntryId || "(end)"}`
    : "(no entries)";
  const footer = options.summaryKind === "branch"
    ? `[branch summarized ${timestamp}; structural source entries ${range}]`
    : `[compacted ${timestamp}; cumulative source entries ${range}]`;
  // The tail is the recall contract: rendered at the fixed footer budget
  // (unscaled, as pi-fabric does) so a tight budget trims sections, never
  // the pointer line.
  blocks.push(boundedBlock("---", [footer, POINTER_LINE], FOOTER_MAX_BYTES));

  const summary = `${blocks.join("\n\n")}\n`;
  if (utf8Bytes(summary) <= limit) return summary;
  // Overflow: drop whole blocks from the front (oldest context first; the
  // footer stays last) until the fixed tail fits, then clamp the head.
  let start = 0;
  let candidate = summary;
  while (start < blocks.length - 1 && utf8Bytes(candidate) > limit) {
    start += 1;
    candidate = `${blocks.slice(start).join("\n\n")}\n`;
  }
  if (utf8Bytes(candidate) <= limit) return candidate;
  const tail = blocks[blocks.length - 1]!;
  const head = blocks.slice(start, -1);
  const headText = head.join("\n\n");
  return `${clipUtf8(headText, Math.max(0, limit - utf8Bytes(tail) - 2))}${headText ? "\n" : ""}${tail}\n`;
};
