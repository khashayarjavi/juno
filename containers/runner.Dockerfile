# juno-runner: the enforcement boundary (build plan §1).
# D-001: nothing is downloaded here except the base image. TypeScript is
# compiled on the host (`make build`) and production node_modules are staged
# on the host (`make stage`); this file only copies them in.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ENV NODE_ENV=production
WORKDIR /app

# Owned by root and read-only to the runtime user: the runner cannot rewrite its own code.
COPY build/stage/package.json ./package.json
COPY build/stage/node_modules ./node_modules
COPY dist ./dist

USER node
CMD ["node", "dist/runner/src/main.js"]
