# D-219: issue #56 reproduced without WSL, rootless Docker or Docker's apt packages

The operator's `make verify-rootless` failed 2 of 118 (`hook-separation.test.ts:118` and `:132`): inside the test
container `juno hook check` exited 1 with empty stdout.

Reproduced in a cloud session on 2026-11-14, on main at dbb272f, with this session's plain root-run Docker 29.9.2 and
one change from the default: the umask the operator's runner terminal has (`sudo -iu juno-runner`, a login shell, where
Ubuntu's `pam_umask` gives a user with its own group `0002`).

```
umask 0002
make build stage
docker compose -f containers/docker-compose.yml build runner
docker run --rm --user 0 --network none --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --cap-add FSETID --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true \
  --mount type=bind,source=$PWD/test/containers/hook-separation,target=/t,readonly --tmpfs /srv/work:mode=0755 \
  --entrypoint /usr/local/bin/node juno-runner:local /t/driver.mjs
```

`results.check` from that run is in `repro-output.txt`: exit 1, empty stdout, and the same refusal list as the issue
(every file of the hook client's folder `0664`, its folders `0775`, all owned by root).

Also checked in this session:

- `stat` after `umask 0002; make build`: `dist`, `dist/mediated`, `dist/mediated/src` are `775`, `juno-hook.js` is `664`.
- A user made with `useradd --user-group`: `sudo -iu <user> -- umask` and `sudo -u <user> -- bash -c umask` print `0002`;
  `runuser -u <user> -- bash -c umask` prints `0022` (`/etc/pam.d/runuser` has no `pam_umask`). This is why CI, which
  ran the suite through `runuser`, never saw it.
- The same user, with umask `0002`, running `sudo touch` and `sudo mkdir`: root's files are `644` and `755`
  (`sudo -V`: "Umask to use or 0777 to use user's: 022"). So the guide's root copy (Part E step 12 onward), made
  through `sudo`, is not affected on a stock Ubuntu.
- Mutations, each under umask `0002`: with only the Makefile's normalisation removed, `code-modes.test.ts`'s host test
  fails and the image (normalised by its Dockerfile) still passes `juno hook check`; with both removed, the operator's
  two failures return exactly, with the three tests of `code-modes.test.ts`.
