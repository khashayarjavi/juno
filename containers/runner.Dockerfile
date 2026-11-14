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
# COPY keeps the modes the files had on the host, so the image would depend on the umask of whoever built them. Take
# group and other write off everything copied, whatever the host gave it: only root may change the runner's code and
# the hook client (DECISIONS.md D-219). Symbolic links are skipped (their mode is fixed); nothing else is touched.
RUN ["find", "/app", "!", "-type", "l", "-perm", "/022", "-exec", "chmod", "go-w", "{}", "+"]

# The journal-vol mount point, owned by the runner user and closed to everyone
# else. A new named volume takes this ownership and mode on first mount.
# Exec form: no shell runs here either.
RUN ["mkdir", "-m", "0700", "/journal"]
RUN ["chown", "node:node", "/journal"]

# The work-vol mount point, with the same owner and mode as in the workload
# image, so a new volume gets them whichever container mounts it first
# (DECISIONS.md D-031). The runner can read the work volume but not write it.
RUN ["mkdir", "-m", "0755", "/work"]
RUN ["chown", "65532:65532", "/work"]

# The runner's own folder for its journal key and its clone of juno-anchors (§3.4.1, D-198): owned by the runner user
# and closed to everyone else, outside the journal and the work volume.
RUN ["mkdir", "-m", "0700", "/var/lib/juno-runner"]
RUN ["chown", "node:node", "/var/lib/juno-runner"]

# The anchor pin (operator ruling D-206 item 2; D-208): root's own file, which the runner user cannot change. This image
# is JUNO's test stack (the operator's runner runs on the host, D-065), it has no git and no network, so the pin names
# the stand-in destination the test stack's stand-in git copies to, and the test stack's journal folders. The
# operator's own pin is written by the operator, as root (docs/operator-setup.md, Part D).
RUN ["mkdir", "-m", "0755", "/etc/juno"]
COPY --chmod=0644 containers/runner-test-anchors.json /etc/juno/anchors.json
# The git program is named only in the pin and must be root's own (operator ruling D-211 item 1; D-213). The image has
# no git (D-001), so the test pin names the test stack's stand-in, copied here as root's file.
RUN ["mkdir", "-m", "0755", "/opt/juno-test"]
COPY --chmod=0755 containers/runner-test-git.mjs /opt/juno-test/git

USER node
CMD ["node", "dist/runner/src/main.js"]
