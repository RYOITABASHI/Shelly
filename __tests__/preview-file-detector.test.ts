import { detectFileType, formatFileSize } from '@/lib/preview-file-detector';

describe('preview-file-detector', () => {
  it('detects file types from extensions', () => {
    expect(detectFileType('notes.md')).toBe('markdown');
    expect(detectFileType('report.JSON')).toBe('json');
    expect(detectFileType('archive.unknown')).toBe('plaintext');
  });

  it('formats file sizes with friendly units', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
