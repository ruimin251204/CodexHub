export type GlobalSearchEntry = {
  id: string;
  label: string;
  detail: string;
  section: string;
  targetId?: string;
  keywords?: readonly string[];
  priority?: number;
};

export type GlobalSearchResult<T extends GlobalSearchEntry = GlobalSearchEntry> = T & {
  score: number;
};

type SearchableField = {
  text: string;
  weight: number;
};

type RankedResult<T extends GlobalSearchEntry> = {
  index: number;
  result: GlobalSearchResult<T>;
};

const EXACT_SCORE = 300;
const PREFIX_SCORE = 200;
const CONTAINS_SCORE = 100;

export function normalizeGlobalSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

export function tokenizeGlobalSearchQuery(query: string): string[] {
  const normalized = normalizeGlobalSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

function matchScore(needle: string, haystack: string): number {
  if (haystack === needle) return EXACT_SCORE;
  if (haystack.startsWith(needle)) return PREFIX_SCORE;
  if (haystack.includes(needle)) return CONTAINS_SCORE;
  return 0;
}

function searchableFields(entry: GlobalSearchEntry): SearchableField[] {
  return [
    { text: normalizeGlobalSearchText(entry.label), weight: 30 },
    ...(entry.keywords ?? []).map((keyword) => ({ text: normalizeGlobalSearchText(keyword), weight: 20 })),
    { text: normalizeGlobalSearchText(entry.detail), weight: 10 }
  ].filter((field) => Boolean(field.text));
}

function scoreEntry(entry: GlobalSearchEntry, normalizedQuery: string, tokens: readonly string[]): number | null {
  const fields = searchableFields(entry);
  let score = entry.priority ?? 0;

  // Every query token must be represented, while tokens may match different fields.
  for (const token of tokens) {
    let bestTokenScore = 0;
    for (const field of fields) {
      const fieldMatchScore = matchScore(token, field.text);
      if (fieldMatchScore > 0) bestTokenScore = Math.max(bestTokenScore, fieldMatchScore + field.weight);
    }
    if (bestTokenScore <= 0) return null;
    score += bestTokenScore;
  }

  // Prefer a complete phrase match when token-level relevance is otherwise similar.
  let bestPhraseScore = 0;
  for (const field of fields) {
    const fieldMatchScore = matchScore(normalizedQuery, field.text);
    if (fieldMatchScore > 0) bestPhraseScore = Math.max(bestPhraseScore, fieldMatchScore * 3 + field.weight);
  }
  return score + bestPhraseScore;
}

export function searchGlobalEntries<T extends GlobalSearchEntry>(
  query: string,
  entries: readonly T[],
  limit = 10
): Array<GlobalSearchResult<T>> {
  const normalizedQuery = normalizeGlobalSearchText(query);
  const tokens = tokenizeGlobalSearchQuery(normalizedQuery);
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (!tokens.length || normalizedLimit === 0) return [];

  const seenIds = new Set<string>();
  const ranked: Array<RankedResult<T>> = [];

  entries.forEach((entry, index) => {
    if (seenIds.has(entry.id)) return;
    seenIds.add(entry.id);

    const score = scoreEntry(entry, normalizedQuery, tokens);
    if (score === null) return;
    ranked.push({ index, result: { ...entry, score } });
  });

  return ranked
    .sort((left, right) => right.result.score - left.result.score || left.index - right.index)
    .slice(0, normalizedLimit)
    .map(({ result }) => result);
}
