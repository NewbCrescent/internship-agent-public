import type { DiscoveredItem } from "@internship-agent/domain";

/**
 * Batch posting format: blocks separated by a line containing only `===`.
 * The first line of each block is `Title @ Company`, an optional
 * `Source: <url>` line may follow, and the rest is the posting body.
 *
 * Parsing is strict: malformed blocks are reported, never silently fixed.
 */
export type ParsedBatch = {
  items: DiscoveredItem[];
  errors: string[];
};

const SEPARATOR = /^\s*===\s*$/;

export function parsePostingBatch(input: string): ParsedBatch {
  const items: DiscoveredItem[] = [];
  const errors: string[] = [];
  const blocks = input.split(/\r?\n/).reduce<string[][]>((acc, line) => {
    if (SEPARATOR.test(line)) acc.push([]);
    else {
      if (acc.length === 0) acc.push([]);
      acc[acc.length - 1].push(line);
    }
    return acc;
  }, []);

  blocks.forEach((lines, index) => {
    if (lines.every((line) => !line.trim())) return;
    const header = (lines[0] ?? "").trim();
    const headerMatch = header.match(/^(.+?)\s+@\s+(.+?)\s*$/);
    if (!headerMatch) {
      errors.push(`Block ${index + 1}: first line must be "Title @ Company".`);
      return;
    }
    const [, title, companyName] = headerMatch;
    let sourceUrl: string | null = null;
    let bodyStart = 1;
    const sourceMatch = (lines[1] ?? "").trim().match(/^Source:\s*(\S+)\s*$/i);
    if (sourceMatch) {
      sourceUrl = sourceMatch[1];
      bodyStart = 2;
    }
    const text = lines.slice(bodyStart).join("\n").trim();
    if (text.length < 80) {
      errors.push(`Block ${index + 1}: body is too short to ingest (minimum 80 characters).`);
      return;
    }
    items.push({ title: title.trim(), companyName: companyName.trim(), text, sourceUrl });
  });

  return { items, errors };
}
