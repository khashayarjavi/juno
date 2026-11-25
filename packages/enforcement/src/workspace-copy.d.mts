// Types for workspace-copy.mjs, the sealed workspace copy (DECISIONS.md D-228). The program itself is plain JavaScript
// so that its text runs unchanged in the sealed context (`node --input-type=module -e`).

export type SealedEntry = { readonly path: string; readonly type: "directory"; readonly mode: number } | { readonly path: string; readonly type: "file"; readonly mode: number; readonly sha256: string };
type Opened = { readonly ok: true; readonly fd: number } | { readonly ok: false; readonly reason: string };
type Judge = { readonly mayChange?: (folder: string) => boolean; readonly uid?: number };

export const FILE_MODE: number;
/** Marks an entry whose set-user-ID, set-group-ID or sticky bit must go; the host names its path and owner (D-247). */
export const BITS_MARK: string;
export const DIR_MODE: number;
export const MAX_ENTRIES: number;
export const MAX_BYTES: number;
export function kernelMayChange(folder: string): boolean;
export function openRootAt(baseFd: number, root: string): Opened;
export function openRoot(base: string, root: string): Opened;
export function listTree(rootFd: number, options?: Judge & { readonly content?: boolean; readonly strict?: boolean }): { readonly ok: true; readonly manifest: SealedEntry[]; readonly contents: Map<string, Buffer> } | { readonly ok: false; readonly reason: string };
export function wanted(manifest: unknown): Map<string, SealedEntry> | string;
export type UndoAnswer = { readonly refused: string[] } | { readonly failed: string; readonly kept: string | null } | { readonly restored: SealedEntry[]; readonly kept: string | null };
export function undoRefusals(baseFd: number, root: string, options?: Judge): string[];
export function undoTo(baseFd: number, root: string, manifest: unknown, content: (hash: string) => Buffer, options?: Judge): UndoAnswer;
export function asideName(name: string, now?: Date): string;
export function remove(dirFd: number, name: string): void;
export function restoreTree(rootFd: number, manifest: unknown, content: (hash: string) => Buffer, options?: Judge): void;
export function main(argv: readonly string[], input: () => Promise<string>): Promise<unknown>;
export function readStdin(): Promise<string>;
