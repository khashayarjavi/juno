# juno-anchors: the test stand-in for the off-host anchor destination (spec §3.4.1, v0.6.1 V6-4; DECISIONS.md D-122).
# Its own image, its own user, its own volume, no network. Its only entrypoint is the fixed append-only store script:
# append and list, never overwrite or delete. The real destination is the operator's public `juno-anchors` repository.
# D-001: nothing is downloaded here except the base images. Exec form only: no shell runs here.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS stage
RUN ["mkdir", "-p", "/stage/anchors"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

# The anchors-vol mount point, owned by the store's user and closed to everyone else. A new named volume takes this
# ownership and mode on first mount.
COPY --from=stage --chown=65533:65533 --chmod=0700 /stage/ /
# The store script, owned by root and read-only to the store's user (0555: BuildKit gives the created parent
# directory the same mode, and a directory needs x to be entered).
COPY --chmod=0555 containers/anchor-store.mjs /opt/juno/anchor-store.mjs

USER 65533:65533
ENTRYPOINT ["/nodejs/bin/node", "/opt/juno/anchor-store.mjs"]
