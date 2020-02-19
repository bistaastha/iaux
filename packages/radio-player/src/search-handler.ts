import { TranscriptConfig, TranscriptEntryConfig } from '@internetarchive/transcript-view';

/**
 * A model to store the start and end indices for a given context.
 * This is used for augmenting the source transcript entries (`TranscriptIndexMap`)
 * as well as the search result entries (`SearchSeparatedTranscriptEntry`) below.
 *
 * @class Range
 */
class Range {
  startIndex: number;

  endIndex: number;

  get length(): number {
    return Math.abs(this.endIndex - this.startIndex);
  }

  constructor(startIndex: number, endIndex: number) {
    this.startIndex = startIndex;
    this.endIndex = endIndex;
  }
}

/**
 * This class augments the transcript entry with the start and end indices.
 * This is useful for more rapidly splitting up and restoring the transcript
 * entries from the transforms that happen during the search.
 *
 * @class TranscriptIndexMap
 */
class TranscriptIndexMap {
  entry: TranscriptEntryConfig;

  range: Range;

  constructor(entry: TranscriptEntryConfig, range: Range) {
    this.entry = entry;
    this.range = range;
  }
}

/**
 * The first step in converting the search results back to a usable transcript
 * is to break up the overall merged transcript into search results and non-search-results
 * sections. This will allow us to more easily break it up into its original transcript
 * chunks in a subsequent process.
 *
 * This class is a container to hold those chunks. They each have a start and end index
 * from their spot in the merged transcript, the text from that chunk, and whether that
 * chunk was a search match or just regular text.
 *
 * @class SearchSeparatedTranscriptEntry
 */
class SearchSeparatedTranscriptEntry {
  range: Range;

  text: string;

  isSearchMatch: boolean;

  constructor(range: Range, text: string, isSearchMatch: boolean) {
    this.range = range;
    this.text = text;
    this.isSearchMatch = isSearchMatch;
  }
}

export default class SearchHandler {
  private transcriptConfig: TranscriptConfig;

  /**
   * This gets populated as part of the search index build. It maps the start and end indicies
   * of all of the transcript entries so we can quickly look up where an entry is in the
   * overall transcript.
   *
   * @private
   * @type {TranscriptIndexMap[]}
   * @memberof SearchHandler
   */
  private transcriptEntryIndices: TranscriptIndexMap[] = [];

  /**
   * This gets populated as part of the search index build. It merges all of the transcript
   * entries together so we can search it as a single document instead of a bunch of
   * individual entries. This allows searches to cross over transcript entries.
   *
   * NOTE: When the mergedTranscript gets created, spaces are put between each transcript
   * entry, otherwise the words would run into each other. We account for this in the
   * indices above.
   *
   * @private
   * @memberof SearchHandler
   */
  private mergedTranscript = '';

  constructor(transcriptConfig: TranscriptConfig) {
    this.transcriptConfig = transcriptConfig;
    this.buildIndex();
  }

  search(term: string): TranscriptConfig {
    const searchSeparatedTranscript = this.getSearchSeparatedTranscript(term);
    const newTranscriptEntries: TranscriptEntryConfig[] = [];

    let searchResultIndex = 0;

    searchSeparatedTranscript.forEach(entry => {
      // If we encounter a match, just create a new transcript entry from it and append it.
      // We don't care if it crosses over multiple transcript entries since we want one match,
      // not multiple broken up by transcript entry.
      if (entry.isSearchMatch) {
        // find the closest source transcript to this entry
        const resultIndexMap = this.getTranscriptEntryIndexMap(entry.range.startIndex);
        if (!resultIndexMap) {
          return;
        }

        const newTranscriptEntry = this.createBlankTranscriptEntryConfig(resultIndexMap.entry);
        newTranscriptEntry.searchMatchIndex = searchResultIndex;
        searchResultIndex += 1;
        newTranscriptEntry.rawText = entry.text;
        newTranscriptEntries.push(newTranscriptEntry);
        return;
      }

      // Next loop through all of the source transcript entries to find the ones that intersect with this
      // search result. If it intersects, we take the intersected characters from the merged transcript
      // and make a new entry from that.
      this.transcriptEntryIndices.forEach((indexMap: TranscriptIndexMap) => {
        const intersection = this.getIntersection(entry.range, indexMap.range);
        if (!intersection || intersection.length === 0) {
          return;
        }

        const newTranscriptEntry = this.createBlankTranscriptEntryConfig(indexMap.entry);
        const text = this.mergedTranscript.substring(
          intersection.startIndex,
          intersection.endIndex,
        );
        newTranscriptEntry.rawText = text.trim();
        newTranscriptEntries.push(newTranscriptEntry);
      });
    });

    const newTranscript = new TranscriptConfig(newTranscriptEntries);

    return newTranscript;
  }

  /* eslint-disable-next-line class-methods-use-this */
  private getIntersection(range1: Range, range2: Range): Range | undefined {
    // get the range with the smaller starting point (min) and greater start (max)
    const minRange: Range = range1.startIndex < range2.startIndex ? range1 : range2;
    const maxRange = minRange === range1 ? range2 : range1;

    // min ends before max starts -> no intersection
    if (minRange.endIndex < maxRange.startIndex) {
      return undefined; // the ranges don't intersect
    }

    const endIndex = minRange.endIndex < maxRange.endIndex ? minRange.endIndex : maxRange.endIndex;
    return new Range(maxRange.startIndex, endIndex);
  }

  private getTranscriptEntryIndexMap(overallCharIndex: number): TranscriptIndexMap | undefined {
    return this.transcriptEntryIndices.find(
      entry =>
        entry.range.endIndex > overallCharIndex && entry.range.startIndex <= overallCharIndex,
    );
  }

  /**
   * Copy a transcript entry but leave the text and search result index empty.
   *
   * @private
   * @param {TranscriptEntryConfig} sourceTranscriptConfig
   * @returns {TranscriptEntryConfig}
   * @memberof SearchHandler
   */
  /* eslint-disable-next-line class-methods-use-this */
  private createBlankTranscriptEntryConfig(
    sourceTranscriptConfig: TranscriptEntryConfig,
  ): TranscriptEntryConfig {
    return new TranscriptEntryConfig(
      sourceTranscriptConfig.id,
      sourceTranscriptConfig.start,
      sourceTranscriptConfig.end,
      '',
      sourceTranscriptConfig.isMusic,
    );
  }

  /**
   * Search the full transcript and split up by search results and non-results. For instance,
   * if the full transcript is `foo bar baz boop bump snap pop` and you search for `bump`,
   * you'll get an array of 3 results back:
   * 1. `foo bar baz boop `
   * 2. `bump` <-- the match
   * 3. ` snap pop`
   *
   * This is helpful when rebuilding the transcript later to be able to identify search results.
   *
   * @private
   * @param {string} term
   * @returns {SearchSeparatedTranscriptEntry[]}
   * @memberof SearchHandler
   */
  private getSearchSeparatedTranscript(term: string): SearchSeparatedTranscriptEntry[] {
    const searchIndices = this.getSearchIndices(term);
    if (searchIndices.length === 0) {
      const range = new Range(0, this.mergedTranscript.length);
      return [new SearchSeparatedTranscriptEntry(range, this.mergedTranscript, false)];
    }

    const transcriptEntries: SearchSeparatedTranscriptEntry[] = [];
    let startIndex = 0;
    searchIndices.forEach(index => {
      const nextStart = index + term.length;
      const nonResultText = this.mergedTranscript.substring(startIndex, index);
      const resultText = this.mergedTranscript.substring(index, nextStart);
      const nonResultRange = new Range(startIndex, index - 1);
      const nonResultEntry = new SearchSeparatedTranscriptEntry(
        nonResultRange,
        nonResultText,
        false,
      );
      const searchResultRange = new Range(index, nextStart - 1);
      const searchResultEntry = new SearchSeparatedTranscriptEntry(
        searchResultRange,
        resultText,
        true,
      );
      transcriptEntries.push(nonResultEntry);
      transcriptEntries.push(searchResultEntry);
      startIndex = nextStart;
    });
    const finalResultText = this.mergedTranscript.substring(
      startIndex,
      this.mergedTranscript.length,
    );
    const finalResultRange = new Range(startIndex, this.mergedTranscript.length);
    const finalResultEntry = new SearchSeparatedTranscriptEntry(
      finalResultRange,
      finalResultText,
      false,
    );
    transcriptEntries.push(finalResultEntry);

    return transcriptEntries;
  }

  /**
   * Finds all of the start indices of all the search results across the entire transcript.
   *
   * @private
   * @param {string} term
   * @returns {number[]}
   * @memberof SearchHandler
   */
  private getSearchIndices(term: string): number[] {
    const regex = new RegExp(term, 'gi');

    const startIndices: number[] = [];
    let result;

    /* eslint-disable-next-line no-cond-assign */
    while ((result = regex.exec(this.mergedTranscript))) {
      startIndices.push(result.index);
    }

    return startIndices;
  }

  /**
   * Build the search index. This method does two things:
   * 1. Builds the "merged transcript" with all of the text combined into one long transcript.
   *    This allows us to search the entire thing at once instead of entry by entry.
   * 2. For each entry, get the start and end index of that particular entry within the overall
   *    transcript. This allows us to reconstruct the transcript later from the original transcript
   *    and the search results.
   *
   * @private
   * @memberof SearchHandler
   */
  private buildIndex(): void {
    let startIndex = 0;
    this.transcriptConfig.entries.forEach((entry: TranscriptEntryConfig) => {
      const { displayText } = entry;
      const indexMapRange: Range = new Range(startIndex, startIndex + displayText.length);
      const indexMap: TranscriptIndexMap = new TranscriptIndexMap(entry, indexMapRange);
      this.transcriptEntryIndices.push(indexMap);
      this.mergedTranscript += `${entry.displayText} `;
      startIndex = this.mergedTranscript.length;
    });
    this.mergedTranscript = this.mergedTranscript.trim();
  }
}
