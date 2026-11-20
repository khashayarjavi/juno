// Types for workspace-copy.mjs, the sealed workspace copy (DECISIONS.md D-228). The program itself is plain JavaScript
// so that its text runs unchanged in the sealed context (`node --input-type=module -e`).

export type SealedEntry = { readonly path: string; readonly type: "directory"; readonly mode: number } | { readonly path: string; readonly type: "file"; readonly mode: number; readonly sha256: string };
type Opened = { readonly ok: true; readonly fd: number } | { readonly ok: false; readonly reason: string };
type Judge = { readonly mayChange?: (folder: string) => boolean; readonly uid?: number };

export const FILE_MODE: number;
export const DIR_MODE: number;
export const MAX_ENTRIES: number;
export const MAX_BYTES: number;
export const MAX_SCAN: number;
export function kernelMayChange(folder: string): boolean;
export function openRootAt(baseFd: number, root: string): Opened;
export function openRoot(base: string, root: string): Opened;
export function listTree(rootFd: number, options?: Judge & { readonly content?: boolean; readonly strict?: boolean }): { readonly ok: true; readonly manifest: SealedEntry[]; readonly contents: Map<string, Buffer> } | { readonly ok: false; readonly reason: string };
export function wanted(manifest: unknown): Map<string, SealedEntry> | string;
export function restoreRefusals(rootFd: number, manifest: unknown, options?: Judge): string[];
export function restoreTree(rootFd: number, manifest: unknown, content: (hash: string) => Buffer, options?: Judge): void;
export function main(argv: readonly string[], input: () => Promise<string>): Promise<unknown>;
export function readStdin(): Promise<string>;
