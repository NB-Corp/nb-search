import type { FetchQualityConfig } from './config-schema.ts';
import { NbSearchError } from './errors.ts';

export function assertFetchQuality(content: string, quality: FetchQualityConfig): void {
  if (quality.min_content_chars > 0 && content.length < quality.min_content_chars) throw new NbSearchError('QUALITY_GATE_FAILED', 'Fetched content is shorter than the configured minimum.', false, undefined, { data: { rule: 'min_content_chars', min_content_chars: quality.min_content_chars, content_chars: content.length } });
  const normalized = content.toLowerCase();
  const marker = quality.blocked_markers.find((item) => normalized.includes(item.toLowerCase()));
  if (marker !== undefined) throw new NbSearchError('QUALITY_GATE_FAILED', 'Fetched content matched a configured blocked marker.', false, undefined, { data: { rule: 'blocked_markers' } });
}
