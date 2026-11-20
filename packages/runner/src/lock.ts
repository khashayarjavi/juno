/**
 * The journal's one-writer lock (D-025, D-064, D-069) lives in the journal package, so the hook and gateway services
 * take it too and `juno checkpoint restore` can prove no service is writing the journal (DECISIONS.md D-221).
 */
export * from "../../journal/src/lock.js";
