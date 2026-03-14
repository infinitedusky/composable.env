import * as fs from 'fs';
import * as path from 'path';

const MARKER_START = '# ce:start';
const MARKER_END = '# ce:end';

export function wrapWithMarkers(content: string): string {
  const trimmed = content.replace(/\n$/, '');
  return `${MARKER_START}\n${trimmed}\n${MARKER_END}\n`;
}

export function hasMarkerBlock(fileContent: string): boolean {
  return fileContent.includes(MARKER_START) && fileContent.includes(MARKER_END);
}

export function replaceMarkerBlock(fileContent: string, newContent: string): string {
  const startIdx = fileContent.indexOf(MARKER_START);
  const endIdx = fileContent.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return fileContent;

  const before = fileContent.slice(0, startIdx);
  const after = fileContent.slice(endIdx + MARKER_END.length + 1);
  return before + wrapWithMarkers(newContent) + after;
}

export function removeMarkerBlock(fileContent: string): string {
  const startIdx = fileContent.indexOf(MARKER_START);
  const endIdx = fileContent.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return fileContent;

  const before = fileContent.slice(0, startIdx);
  const after = fileContent.slice(endIdx + MARKER_END.length + 1);

  // Clean up extra blank lines left behind
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

// --- CENV_ENC detection (no crypto deps) ---

const CENV_ENC_PREFIX = 'CENV_ENC[';
const CENV_ENC_SUFFIX = ']';

export function isCenvEncrypted(value: string): boolean {
  return value.startsWith(CENV_ENC_PREFIX) && value.endsWith(CENV_ENC_SUFFIX);
}

// --- JSON ownership tracking via .ce-managed.json ---

export interface ManagedJsonEntry {
  file: string;
  keys: Record<string, string[]>;
}

interface ManagedRegistry {
  version: number;
  managed: ManagedJsonEntry[];
}

export class ManagedJsonRegistry {
  private registryPath: string;

  constructor(projectRoot: string) {
    this.registryPath = path.join(projectRoot, '.ce-managed.json');
    // Fallback to legacy path
    if (!fs.existsSync(this.registryPath)) {
      const legacy = path.join(projectRoot, '.cenv-managed.json');
      if (fs.existsSync(legacy)) this.registryPath = legacy;
    }
  }

  load(): ManagedJsonEntry[] {
    if (!fs.existsSync(this.registryPath)) return [];
    try {
      const data: ManagedRegistry = JSON.parse(
        fs.readFileSync(this.registryPath, 'utf8')
      );
      return data.managed || [];
    } catch {
      return [];
    }
  }

  save(entries: ManagedJsonEntry[]): void {
    const data: ManagedRegistry = { version: 1, managed: entries };
    fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2) + '\n');
  }

  register(file: string, jsonPath: string, keys: string[]): void {
    const entries = this.load();
    let entry = entries.find(e => e.file === file);

    if (!entry) {
      entry = { file, keys: {} };
      entries.push(entry);
    }

    const existing = entry.keys[jsonPath] || [];
    const merged = [...new Set([...existing, ...keys])];
    entry.keys[jsonPath] = merged;

    this.save(entries);
  }

  getEntries(file: string): ManagedJsonEntry | undefined {
    return this.load().find(e => e.file === file);
  }

  unregisterAll(): ManagedJsonEntry[] {
    const entries = this.load();
    this.remove();
    return entries;
  }

  remove(): void {
    if (fs.existsSync(this.registryPath)) {
      fs.unlinkSync(this.registryPath);
    }
  }
}
