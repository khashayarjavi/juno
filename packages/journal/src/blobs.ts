import { dirname } from "node:path";
import type { AbsolutePath, ContentHash } from "../../contracts/src/index.js";
import { contentAddress } from "./canonical.js";
import { ensureDir, readOptional, replaceDurably } from "./files.js";
import { blobFile } from "./layout.js";

/**
 * Content-addressed blob store for payloads (build plan Increment 2). A blob's
 * name is the digest of its bytes, so a blob cannot be changed without its
 * name no longer matching, and every read checks that it still does.
 */

/**
 * `present`: the bytes, which match their address.
 * `missing`: no blob is stored at that address (for example, deleted under a retention rule).
 * `corrupt`: a blob is stored there but its bytes no longer match the address. They are never returned.
 */
export type BlobRead =
  | { readonly status: "present"; readonly bytes: Uint8Array }
  | { readonly status: "missing" }
  | { readonly status: "corrupt" };

export function putBlob(root: AbsolutePath, bytes: Uint8Array): ContentHash {
  const ref = contentAddress(bytes);
  if (getBlob(root, ref).status !== "present") {
    const path = blobFile(root, ref);
    ensureDir(dirname(path));
    replaceDurably(path, bytes);
  }
  return ref;
}

export function getBlob(root: AbsolutePath, ref: ContentHash): BlobRead {
  const bytes = readOptional(blobFile(root, ref));
  if (bytes === null) {
    return { status: "missing" };
  }
  if (contentAddress(bytes) !== ref) {
    return { status: "corrupt" };
  }
  return { status: "present", bytes: new Uint8Array(bytes) };
}
