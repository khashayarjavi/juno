import { main } from "./mcp-shim.js";

// The `juno-mcp` executable entry point (D-188).
void main(process.argv.slice(2), process.stdin, process.stdout);
