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

# The journal-vol mount point, owned by the runner user and closed to everyone
# else. A new named volume takes this ownership and mode on first mount.
# Exec form: no shell runs here either.
RUN ["mkdir", "-m", "0700", "/journal"]
RUN ["chown", "node:node", "/journal"]

USER node
CMD ["node", "dist/runner/src/main.js"]
