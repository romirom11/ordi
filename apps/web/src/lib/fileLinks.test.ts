import { describe, expect, it } from 'vitest';
import { filePathOf } from './fileLinks';

describe('filePathOf', () => {
  it('finds the file path in a relative or absolute src', () => {
    expect(filePathOf('/api/v1/files/01ABC/1700000000.abcdef')).toBe('/api/v1/files/01ABC/1700000000.abcdef');
    expect(filePathOf('https://ordi.example.com/api/v1/files/01ABC/tok?x=1')).toBe('/api/v1/files/01ABC/tok');
  });

  it('ignores anything that is not a file link', () => {
    expect(filePathOf('data:image/png;base64,AAAA')).toBeNull();
    expect(filePathOf('https://example.com/logo.png')).toBeNull();
    expect(filePathOf('/api/v1/files/only-id')).toBeNull();
  });
});
