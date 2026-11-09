# Operator setup — JUNO on Windows with WSL2

This is the one document for setting JUNO up on your own machine. It collects every step from STATE.md (Parts A to F) and the steps Slice 1.5 added, in the order to do them. Do the parts in order. Every part ends with a **Check**: if a check does not show what it says, stop there and send the agent the last 15 lines on your screen.

**You never paste a secret anywhere.** Every step that creates a credential is marked **Creates a credential**. A password, passphrase or sign-in code is only ever typed or pasted into the program on your own machine that asked for it. Only *public* keys are ever copied: into GitHub, or into a message to the agent. If any step seems to ask you to paste a private key, a passphrase or a token into a website, a chat or a file, stop: that step is wrong.

What the setup gives you, in plain words:
- A **grant-signing key** that Windows keeps (Part B). JUNO honours only grants signed with it.
- A WSL2 Ubuntu with three Linux users (Part E): your **admin** user; **`juno-runner`**, which runs JUNO and owns its journal; and **`juno-agent`**, the only user Claude Code runs as.
- A public GitHub repository, **`juno-anchors`**, that receives a fingerprint of JUNO's journal at least once a minute, so no one on your machine can quietly rewrite history (Part D).
- JUNO's **hook service**, which judges every tool call of a Claude Code session you admitted (Part G).

Time: about three hours in total, most of it waiting for installs. You can stop between parts.

How to open the windows this guide uses:
- **PowerShell**: press the Windows key, type `PowerShell`, press Enter. *As administrator*: right-click **Windows PowerShell** and choose **Run as administrator**.
- **Admin terminal** (from Part E on): in PowerShell, type `wsl -d Ubuntu-24.04 -u <your admin name>` and press Enter.
- **Runner terminal** (from Part E on): in PowerShell, type `wsl -d Ubuntu-24.04 -u juno-runner` and press Enter. The prompt starts with `juno-runner@`.
- **Governed terminal** (from Part E step 10 on): Start menu → **Ubuntu 24.04**. It opens as `juno-agent`.

Boxes of commands: paste each box whole into the window named above it and press Enter. If your Windows user name contains a space, stop before Part E step 13 and tell the agent: the `cmd /c` copy lines need a different form for that.

---

## Part A — Windows prerequisites (once, about 15 minutes)

1. Check that the OpenSSH client is present. **PowerShell:** type `Get-Command ssh-keygen` and press Enter. If you see a path ending in `ssh-keygen.exe`, continue. If you see an error: open **Settings → System → Optional features → View features** (Windows 10: **Settings → Apps → Optional features → Add a feature**), search for **OpenSSH Client**, tick it, and click **Install**.
2. Check that Git and Node.js 22 are installed. **PowerShell:** `git --version` and `node --version` should each print a version, and node's should start with `v22`. If not, install Git for Windows from https://git-scm.com/download/win and Node.js 22 LTS from https://nodejs.org, accepting the defaults, then close and reopen PowerShell.
3. Get JUNO's command on Windows (it is used only to sign grants). **PowerShell:**
   ```
   git clone https://github.com/khashayarjavi/juno.git $env:USERPROFILE\juno
   cd $env:USERPROFILE\juno
   npm ci
   npx tsc -p tsconfig.build.json
   ```

**Check:** `node $env:USERPROFILE\juno\dist\runner\src\juno.js` prints a line starting `usage: juno grant sign|verify`.

## Part B — your grant-signing key, kept by Windows (once, about 10 minutes)

**Creates a credential:** your grant-signing key. Its private half never leaves Windows' key agent after step 4.

1. *As administrator*, turn on the key agent (it is off by default). **PowerShell (as administrator):**
   ```
   Get-Service ssh-agent | Set-Service -StartupType Automatic
   Start-Service ssh-agent
   Get-Service ssh-agent
   ```
   The last line must say **Running**. Close the administrator window.
2. In a normal PowerShell window, create the key:
   ```
   ssh-keygen -t ed25519 -C "juno-grant-signing" -f $env:USERPROFILE\.ssh\juno_grant
   ```
   When it asks for a passphrase, type a strong one twice. It does not show what you type. Do not write it anywhere on this computer.
3. Hand the key to the agent: `ssh-add $env:USERPROFILE\.ssh\juno_grant`, then type the passphrase when asked.
4. Back up the private key file `C:\Users\<you>\.ssh\juno_grant` (the one **without** `.pub`) to somewhere off this computer that you control, for example a USB stick you keep safe, or your password manager's file attachment. Then delete it from the computer: `Remove-Item $env:USERPROFILE\.ssh\juno_grant`.
5. **Keep** `juno_grant.pub`. It is your public key: the trust anchor JUNO checks every grant against. It is not secret.

**Check:** `ssh-add -l` lists one line ending in `juno-grant-signing (ED25519)`, and `Test-Path $env:USERPROFILE\.ssh\juno_grant` prints `False`.

What this protects, and what it does not: Windows' agent never hands out the key, but any program running as your Windows user can ask it to sign (D-093).

## Part C — sign your first grant, and check it (about 5 minutes)

A grant is a signed permission: "this principal may use these capabilities, on these paths, until this time". JUNO honours nothing else.

1. Copy the example grant for Claude Code sessions and open it. **PowerShell:**
   ```
   Copy-Item $env:USERPROFILE\juno\docs\examples\grant-claude-code.example.json $env:USERPROFILE\my-grant.json
   notepad $env:USERPROFILE\my-grant.json
   ```
   It lets the session read, list, write and edit files under `/work/project` (that is `/srv/juno-work/project`) and run the read-only programs your session file names, at most 200 times. In Notepad change only two values: `issued_at`, to **yesterday's** date (keep the form `2026-11-08T00:00:00.000Z`; yesterday, because the time is UTC and a grant issued in the future is refused), and `expires_at`, to the last day it should be valid. Save with **Ctrl+S** and close Notepad.
2. Sign it. **PowerShell**, in `$env:USERPROFILE\juno`:
   ```
   cd $env:USERPROFILE\juno
   node dist\runner\src\juno.js grant sign --ssh-key $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\my-grant.json --out $env:USERPROFILE\signed-grant.json
   ```
   It prints `signed grant written to ...`. If it fails with "agent", repeat Part B step 3.
3. Verify it:
   ```
   node dist\runner\src\juno.js grant verify --anchor $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\signed-grant.json
   ```
4. Optional, to see forgery fail: copy `signed-grant.json` to `forged.json`, open the copy in Notepad, change `"max_invocations": 200` to `201`, save, and run step 3 on `forged.json`. It must print `invalid`. Then delete `forged.json`.

**Check:** step 3 prints `valid`.

## Part E — WSL2 for the runner and for governed Claude Code work (about an hour)

**The rule (D-173): JUNO governs Claude Code only when it runs inside WSL2**, as the Linux user `juno-agent`, started from the governed terminal this part sets up. **A Claude Code session you start on Windows itself (PowerShell, a Windows terminal, a Windows editor) is not governed at all: JUNO never sees it.**

Part E comes before Part D because Part D's push key is made inside WSL.

1. **Install Ubuntu 24.04 in WSL2.** **PowerShell (as administrator):**
   ```
   wsl --update
   wsl --list --online
   ```
   The list must include `Ubuntu-24.04`. Then:
   ```
   wsl --install -d Ubuntu-24.04
   ```
   **Creates a credential:** your admin user's password.
   An Ubuntu window opens and asks for a new UNIX user name and password. Choose your own and type the password when it asks (it does not show what you type): this is your **admin** user, with sudo. JUNO never runs as it.
   **Check** (PowerShell): `wsl --list --verbose` shows `Ubuntu-24.04` with `VERSION` `2`.
2. **Turn on systemd.** In the Ubuntu window:
   ```
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```
   Then in **PowerShell**: `wsl --shutdown`. Wait 10 seconds and open Ubuntu again (Start menu → **Ubuntu 24.04**).
   **Check** (Ubuntu): `systemctl is-system-running` prints `running` or `degraded`, and `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`.
3. **Install Docker Engine 29.9.2 from Docker's own repository, and git.** Ubuntu:
   ```
   sudo apt update
   sudo apt install -y ca-certificates curl uidmap dbus-user-session git make
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n' | sudo tee /etc/apt/sources.list.d/docker.sources
   sudo apt update
   V=5:29.9.2-1~ubuntu.24.04~noble
   sudo apt install -y docker-ce=$V docker-ce-cli=$V docker-ce-rootless-extras=$V containerd.io docker-buildx-plugin docker-compose-plugin
   ```
   If apt says a version was not found, stop and tell the agent.
   **Check:** `dockerd-rootless-setuptool.sh --help` prints a usage text, and `ls -l /usr/bin/git` names `root root`.
4. **Switch off the root-run Docker** (anyone who can reach it is root). Ubuntu:
   ```
   sudo systemctl disable --now docker.service docker.socket
   sudo rm -f /var/run/docker.sock
   getent group docker
   ```
   **Check:** the last line looks like `docker:x:999:`, with nothing after the last colon. If a name appears there, run `sudo gpasswd -d <that name> docker`.
5. **Let user services set CPU limits.** Ubuntu:
   ```
   sudo mkdir -p /etc/systemd/system/user@.service.d
   printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
   sudo systemctl daemon-reload
   ```
   **Check:** `cat /etc/systemd/system/user@.service.d/delegate.conf` prints the two lines.
6. **Create the runner's user, `juno-runner`** (no password, no sudo, no extra group). Ubuntu:
   ```
   sudo useradd --create-home --user-group --shell /bin/bash juno-runner
   sudo passwd -l juno-runner
   sudo loginctl enable-linger juno-runner
   id juno-runner
   grep juno-runner /etc/subuid /etc/subgid
   ```
   **Check:** the `id` line ends with `groups=NNNN(juno-runner)` (exactly one group), and `grep` prints two lines. If it prints nothing, run `sudo usermod --add-subuids 300000-365535 --add-subgids 300000-365535 juno-runner`.
7. **Install Node.js 22 for the runner** (the official archive, checked by its SHA-256). Ubuntu:
   ```
   cd /tmp
   curl -fsSLO https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz
   echo "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce  node-v22.23.4-linux-x64.tar.xz" | sha256sum -c
   sudo mkdir -p /opt/node22
   sudo tar xJf node-v22.23.4-linux-x64.tar.xz -C /opt/node22 --strip-components=1 --no-same-owner
   /opt/node22/bin/node --version
   ```
   **Check:** `node-v22.23.4-linux-x64.tar.xz: OK`, then `v22.23.4`.
8. **Start rootless Docker as `juno-runner`.** Ubuntu, first `sudo -iu juno-runner` (the prompt now starts with `juno-runner@`), then:
   ```
   printf 'export XDG_RUNTIME_DIR=/run/user/$(id -u)\nexport DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus\nexport DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock\nexport PATH=/opt/node22/bin:$PATH\n' >> ~/.bashrc
   source ~/.bashrc
   dockerd-rootless-setuptool.sh install
   systemctl --user enable docker.service
   docker info --format 'cgroup v{{.CgroupVersion}} {{.CgroupDriver}} {{json .SecurityOptions}}'
   cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
   ```
   **Check:** the `docker info` line starts `cgroup v2 systemd` and contains `"name=rootless"`; the last line contains `cpu`, `memory` and `pids`. If it says `none` instead of `systemd`, stop and tell the agent. Type `exit` to go back to your admin user.
9. **Create the Claude Code user, `juno-agent`, and the socket group, `juno-hook`.** Ubuntu (admin):
   ```
   sudo groupadd --system juno-hook
   sudo useradd --create-home --user-group --shell /bin/bash juno-agent
   sudo usermod -aG juno-hook juno-agent
   sudo passwd -l juno-agent
   id juno-agent
   id juno-runner
   ```
   **Check:** the `juno-agent` line lists exactly two groups, `juno-agent` and `juno-hook`; the `juno-runner` line still lists one group and not `juno-hook`.
10. **Switch off interop and drive mounting, and open WSL as `juno-agent`.** Ubuntu (admin):
    ```
    printf '[boot]\nsystemd=true\n\n[interop]\nenabled=false\nappendWindowsPath=false\n\n[automount]\nenabled=false\n\n[user]\ndefault=juno-agent\n' | sudo tee /etc/wsl.conf
    sudo chown root:root /etc/wsl.conf
    sudo chmod 0644 /etc/wsl.conf
    ```
    Then in **PowerShell**: `wsl --shutdown`, wait 10 seconds, and check `wsl --list --running` says there are no running distributions. Open the **governed terminal** (Start menu → **Ubuntu 24.04**).
    **Check**, in the governed terminal: `whoami` prints `juno-agent`; `ls /mnt/c` prints `No such file or directory`; `echo "[$WSL_INTEROP]"` prints `[]`; `sudo -n true` fails; `echo x >> /etc/wsl.conf` prints `Permission denied`. And in **PowerShell**: `wsl.exe -d Ubuntu-24.04 --user juno-runner --exec /usr/bin/id` prints a line with `(juno-runner)`.
11. **Run JUNO's rootless checks on your machine.** Runner terminal:
    ```
    git clone https://github.com/khashayarjavi/juno.git ~/juno
    cd ~/juno
    npm ci
    make verify-rootless
    ```
    **Check:** after 10 to 20 minutes the last line is `make verify-rootless: GREEN`. Send the agent the summary lines, or the last 15 lines if it is not green.
12. **A root-owned copy of JUNO, its folders, and the governed workspace.** Admin terminal:
    ```
    sudo git clone https://github.com/khashayarjavi/juno.git /opt/juno
    cd /opt/juno
    sudo env PATH=/opt/node22/bin:$PATH npm ci --ignore-scripts
    sudo env PATH=/opt/node22/bin:$PATH make build
    sudo install -d -o juno-runner -g juno-runner -m 0700 /var/lib/juno-runner
    sudo install -d -o juno-runner -g juno-runner -m 0700 /var/lib/juno-runner/grants
    sudo install -d -o juno-runner -g juno-hook -m 2750 /var/lib/juno-hook
    sudo install -d -o juno-agent -g juno-agent -m 0755 /srv/juno-work
    ls -ld /opt/juno /opt/juno/dist/mediated/src /opt/juno/dist/mediated/definitions /var/lib/juno-runner /var/lib/juno-hook /srv/juno-work
    ```
    `make build` (not `tsc` alone) also copies the capability definitions the hook service needs beside the built code (D-197).
    **Check**, in the listing: `/opt/juno`, its `dist/mediated/src` and `dist/mediated/definitions` start `drwxr-xr-x` and name `root root`; `/var/lib/juno-runner` is `drwx------ juno-runner juno-runner`; `/var/lib/juno-hook` is `drwxr-s--- juno-runner juno-hook`; `/srv/juno-work` is `drwxr-xr-x juno-agent juno-agent`. Then `stat -f -c %T /srv/juno-work` prints `ext2/ext3` (that is how `stat` names ext4) and `lsattr -d /srv/juno-work` prints a line with no `F` before the path.
    **Never use a Windows folder** (anything under `/mnt/`, or a folder mounted from Windows) as the workspace or a source: JUNO refuses it (D-178).
13. **Put your public key (Part B) where JUNO reads it.** It is public; this copies it byte for byte from Windows into WSL. **PowerShell** (normal):
    ```
    wsl -d Ubuntu-24.04 -u root --exec /usr/bin/install -d -m 0755 /etc/juno
    cmd /c "wsl -d Ubuntu-24.04 -u root --exec /usr/bin/dd of=/etc/juno/operator.pub status=none < %USERPROFILE%\.ssh\juno_grant.pub"
    wsl -d Ubuntu-24.04 -u root --exec /usr/bin/chmod 0444 /etc/juno/operator.pub
    wsl -d Ubuntu-24.04 -u root --exec /usr/bin/ls -l /etc/juno/operator.pub
    ```
    **Check:** the last line starts `-r--r--r--` and names `root root`; and `wsl -d Ubuntu-24.04 -u root --exec /usr/bin/cat /etc/juno/operator.pub` prints the same `ssh-ed25519 ...` line as `Get-Content $env:USERPROFILE\.ssh\juno_grant.pub`.
14. **Install Claude Code inside WSL, as `juno-agent`, and sign in.** In the governed terminal, follow Anthropic's current Linux installation page for Claude Code (docs.claude.com → Claude Code → Set up). Do not install it from a Windows window.
    **Creates a credential:** Claude Code's sign-in, stored in `juno-agent`'s own home. Start `claude` once in the governed terminal. Interop is off, so it cannot open a browser for you: it prints a web address. Open that address in your Windows browser, sign in to your Claude account there, and paste the code the page shows back into the governed terminal, where `claude` is waiting for it. Then type `/exit`.
    **Check:** `claude --version` prints `2.1.299` or later, and `which claude` prints a path. Note that path for the next step.
15. **Install JUNO's hook into Claude Code's managed settings.** Admin terminal; replace `<claude path>` with what `which claude` printed:
    ```
    sudo /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook install --socket /var/lib/juno-hook/hook.sock --client /opt/juno/dist/mediated/src/juno-hook.js --node /opt/node22/bin/node --claude <claude path>
    ls -l /etc/claude-code/managed-settings.json
    ```
    **Check:** the install prints `JUNO's hook is installed in /etc/claude-code/managed-settings.json`, then a list of what it cannot control; the `ls` line starts `-rw-r--r--` and names `root root`. (The full separation check comes in Part G, once the hook service runs.)

**Check for Part E as a whole:** steps 10, 11, 12 and 15 each showed what they say: the governed terminal opens as `juno-agent` with no Windows drives, `make verify-rootless` is GREEN on your machine, the folders have the owners and modes listed, and the hook is installed in root's managed settings.

## Part D — the public anchor repository `juno-anchors` (about 20 minutes)

JUNO copies a fingerprint of its journal to this repository at least once a minute and whenever it stops (§3.4.1). A fingerprint holds only hashes, numbers, a time and a signature, so publishing it reveals nothing about your work; it only lets anyone check, later, that the journal was not rewritten.

**Creates a credential:** a push key that can write to `juno-anchors` and nothing else (a GitHub *deploy key*). It is made inside WSL as `juno-runner`, and its private half never leaves `juno-runner`'s own folder. Only its **public** half is copied into GitHub. (This replaces the earlier plan of a personal access token, which you would have had to paste somewhere; D-199.)

1. **Create the repository.** On https://github.com, click **+** (top right) → **New repository**. Repository name: `juno-anchors`. Choose **Public**. Tick **Add a README file**. Click **Create repository**.
2. **Protect its history.** On the repository page click **Settings**, then in the left sidebar **Rules → Rulesets**, then **New ruleset → New branch ruleset**:
   - Ruleset name: `protect-history`. Enforcement status: **Active**. Leave the bypass list **empty**.
   - Under "Target branches": **Add a target → Include default branch**.
   - Under "Branch protections": tick **Restrict deletions** and **Block force pushes**.
   - Click **Create**.
3. **Make the push key, as `juno-runner`.** Runner terminal:
   ```
   ssh-keygen -t ed25519 -N "" -C "juno-anchors-push" -f ~/.ssh/juno_anchors
   printf 'Host github.com\n  IdentityFile ~/.ssh/juno_anchors\n  IdentitiesOnly yes\n' >> ~/.ssh/config
   chmod 0600 ~/.ssh/config ~/.ssh/juno_anchors
   cat ~/.ssh/juno_anchors.pub
   ```
   It has no passphrase because the service pushes on its own; the file is readable by `juno-runner` alone. The last line printed starts `ssh-ed25519` and ends `juno-anchors-push`: that is the **public** half.
4. **Give the public half to the repository, with write access.** First copy it to the Windows clipboard. **PowerShell** (normal):
   ```
   wsl -d Ubuntu-24.04 -u juno-runner --exec /usr/bin/cat /home/juno-runner/.ssh/juno_anchors.pub | Set-Clipboard
   ```
   Then on `juno-anchors`: **Settings → Deploy keys → Add deploy key**. Title: `juno-runner`. Click in the Key box and press **Ctrl+V**: it shows one line starting `ssh-ed25519` and ending `juno-anchors-push`. (If it shows anything else, for example `BEGIN OPENSSH PRIVATE KEY`, stop: that is the private half; clear the box and tell the agent.) Tick **Allow write access**. Click **Add key**.
5. **Clone it for the runner.** Runner terminal; replace `<you>` with your GitHub user name:
   ```
   ssh -T git@github.com
   ```
   The first time, it asks whether to trust GitHub's host key and shows a fingerprint. Open GitHub's page "GitHub's SSH key fingerprints" (docs.github.com, search for that title) and compare the fingerprint shown with the one listed there for ED25519; type `yes` only if they match exactly. It then prints `Hi <you>/juno-anchors! You've successfully authenticated, but GitHub does not provide shell access.` Then:
   ```
   git clone git@github.com:<you>/juno-anchors.git /var/lib/juno-runner/juno-anchors
   git -C /var/lib/juno-runner/juno-anchors push --dry-run
   ```
6. **Check the protection without touching history.** On GitHub: **Settings → Rules → Rulesets → protect-history** shows **Active**, the default branch as target, and both protections ticked. Do not try to delete or force-push anything to test it.

**Check:** step 5's `ssh -T` line names `juno-anchors`, and `push --dry-run` prints `Everything up-to-date`.

## Part F — what Claude Code may read (read once, about 10 minutes)

When JUNO admits a Claude Code session, you list the **sources** the session may read, each with a class: `public`, `internal`, `confidential` or `secret`. JUNO counts **anything Claude reads that no listed source matches** at the **highest class you listed**. If that class is above the session's clearance (`provider_clearance`), the call is stopped before it runs; if not, it runs and its result is recorded at that class.

- **Where governed work happens.** Only in the governed terminal, with the project in `/srv/juno-work`. Claude names paths such as `/srv/juno-work/project/notes.txt`; JUNO knows that as `/work/project/notes.txt`. A Windows-form path (a backslash, a drive letter like `C:`, or `\\wsl.localhost\...`) is always refused.
- **Shortcuts (symlinks).** A shortcut keeps its class when it and the place it leads to lie in exactly the same sources; a `node_modules/.bin` inside your project is the usual case. A shortcut into a different source, out of your sources, or outside the workspace counts at your highest class. A single read that meets more than 64 shortcuts counts at your highest class, so `ls -R` over a large `node_modules` can be stopped under a low clearance.
- **Web fetches.** A fetched page matches no folder, so with folders alone every web fetch counts at your highest class. To allow some, add a web source: one site (`{ "kind": "url", "origin": "https://docs.python.org" }`, the safest), or the public internet (`{ "kind": "internet" }`, which never matches an IP address, `localhost`, a one-part name, private endings like `.local` or `.internal`, or an unusual port). If your company's intranet uses public-looking names such as `wiki.yourcompany.com`, list exact sites instead of the internet. A fetch still needs a grant that names the exact address (`enumerated_targets`).
- **Everything else.** A file reached through a shortcut is counted by where it leads; a file with two names (a hard link) at your highest class; a folder by everything inside it. A tool JUNO does not know is refused.

A `sources` list with folders and the web looks like this:
```json
"sources": [
  { "id": "project", "selector": { "kind": "path", "prefix": "/work/project" }, "data_class": { "sensitivity": "internal", "integrity": "untrusted" } },
  { "id": "secrets", "selector": { "kind": "path", "prefix": "/work/project/secrets" }, "data_class": { "sensitivity": "secret", "integrity": "operator" } },
  { "id": "python-docs", "selector": { "kind": "url", "origin": "https://docs.python.org" }, "data_class": { "sensitivity": "public", "integrity": "untrusted" } }
]
```

**Check:** you can say, for your first session, which folders it may read and at which class, and what its clearance is. You will write them in Part G step 2.

## Part G — start JUNO's hook service and admit your first session (about 20 minutes)

1. **Copy your signed grant into the runner's folder** (byte for byte; a grant is only as good as its signature, so the copy cannot weaken it). **PowerShell** (normal):
   ```
   cmd /c "wsl -d Ubuntu-24.04 -u juno-runner --exec /usr/bin/dd of=/var/lib/juno-runner/grants/grant-operator-first.json status=none < %USERPROFILE%\signed-grant.json"
   wsl -d Ubuntu-24.04 -u juno-runner --exec /usr/bin/chmod 0600 /var/lib/juno-runner/grants/grant-operator-first.json
   ```
   Then, in the runner terminal:
   ```
   /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js grant verify --anchor /etc/juno/operator.pub /var/lib/juno-runner/grants/grant-operator-first.json
   ```
   It must print `valid`.
2. **Write the session file.** Runner terminal:
   ```
   cp /opt/juno/docs/examples/session.example.json /var/lib/juno-runner/session.json
   chmod 0600 /var/lib/juno-runner/session.json
   cat /proc/sys/kernel/random/uuid
   nano /var/lib/juno-runner/session.json
   ```
   In nano, change only what the file's comments name: put the UUID the `cat` line printed into `session_id`; set `sources` and `provider_clearance` as you decided in Part F; keep `grants` as `grant-operator-first` unless you signed another. Save with **Ctrl+O**, Enter, and leave with **Ctrl+X**.
3. **Start the service.** **Creates a credential:** on its first start the service makes JUNO's journal key (`/var/lib/juno-runner/journal-key`, readable by `juno-runner` only), which signs every anchor. It is not your grant-signing key, and you never handle it. Runner terminal:
   ```
   mkdir -p ~/.config/systemd/user
   cp /opt/juno/docs/examples/juno-hook.service ~/.config/systemd/user/juno-hook.service
   systemctl --user daemon-reload
   systemctl --user enable --now juno-hook.service
   systemctl --user status juno-hook.service --no-pager
   ```
   **Check:** the status shows `active (running)` and a line `juno hook: serving /var/lib/juno-hook/hook.sock`. If it shows `inactive` or `failed`, run `journalctl --user -u juno-hook.service --no-pager | tail -20`: it lists every refusal in plain words. Send them to the agent.
4. **Check the separation** (D-173). Admin terminal:
   ```
   sudo /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook check --agent-user juno-agent --runner-user juno-runner --socket /var/lib/juno-hook/hook.sock --client /opt/juno/dist/mediated/src/juno-hook.js --node /opt/node22/bin/node --state /var/lib/juno-runner --workspace /srv/juno-work --anchor /etc/juno/operator.pub
   ```
   **Check:** it prints `separated from the runner` and `case-sensitive Linux file system`.
5. **Admit the session.** Runner terminal:
   ```
   /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook admit --control /var/lib/juno-runner/admit.sock /var/lib/juno-runner/session.json
   ```
   **Check:** it prints `admitted session-<your UUID>`, a line `Start Claude Code for it with: claude --session-id <your UUID>`, and a line starting `Check its journal with:`. Keep that last line.
6. **Work, governed.** In the governed terminal, make the project folder your grant covers (once) and go to it:
   ```
   mkdir -p /srv/juno-work/project
   cd /srv/juno-work
   ```
   then run the `claude --session-id ...` line from step 5. Ask Claude to write a file outside your grant (for example `/srv/juno-work/outside.txt` if your grant covers only `/work/project`).
   **Check:** Claude reports that JUNO blocked the call (`scope_violation`), and the file does not exist (`ls /srv/juno-work/outside.txt` says `No such file or directory`).
7. **Check the journal against what GitHub holds.** The check that counts is against a fresh copy of `juno-anchors` taken from GitHub, not the runner's own clone, because the runner's clone is on the same machine as the journal. After you finish the session, in the runner terminal (replace `<you>` with your GitHub user name):
   ```
   systemctl --user stop juno-hook.service
   rm -rf ~/anchors-check
   git clone --quiet https://github.com/<you>/juno-anchors.git ~/anchors-check
   ```
   Stopping the service anchors what is pending. Then run the `Check its journal with:` line from step 5, but with `--anchors ~/anchors-check` in place of `--anchors /var/lib/juno-runner/juno-anchors`.
   **Check:** it prints JSON with `"ok": true` and `"unanchored": 0`. Then start the service again: `systemctl --user start juno-hook.service`.

A session JUNO did not admit is denied every call. Each new Claude Code session needs its own `session_id` (step 2) and `juno hook admit` (step 5).

## Part H — optional: govern an MCP server through JUNO's gateway (mode B)

Only if you want Claude Code to use an MCP server (a tool server such as a mail or ticket system) under JUNO's control. The gateway needs a definition of each tool the server offers; writing those is not click-by-click work. **Ask the agent to write the gateway session file for your server and the grant to sign for it** (D-187, D-191). Sign that grant as in Part C and copy it in as in Part G step 1. Then:

1. **Add the gateway to Claude Code's managed settings.** Admin terminal (replace `<claude path>` as in Part E step 15):
   ```
   sudo /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook install --socket /var/lib/juno-hook/hook.sock --client /opt/juno/dist/mediated/src/juno-hook.js --node /opt/node22/bin/node --claude <claude path> --gateway juno --shim /opt/juno/dist/mediated/src/juno-mcp.js --gateway-socket /var/lib/juno-hook/gateway.sock
   ```
   **Check:** it also prints `JUNO's gateway relay juno is the only MCP server Claude Code loads`.
2. **Tell the hook service about the gateway** (without this, the hook denies every MCP call). Runner terminal:
   ```
   sed -i 's| --protect /home/juno-agent$| --protect /home/juno-agent --gateway juno|' ~/.config/systemd/user/juno-hook.service
   systemctl --user daemon-reload
   systemctl --user restart juno-hook.service
   grep -c -- '--gateway juno' ~/.config/systemd/user/juno-hook.service
   ```
   **Check:** the last line prints `1`, and `systemctl --user status juno-hook.service --no-pager` shows `active (running)`. Admit your Claude Code session again (Part G step 5): a restart forgets admitted sessions.
3. **A clone of `juno-anchors` of the gateway's own** (the hook service keeps using its clone; both push to the same repository safely, D-199). Runner terminal (replace `<you>`):
   ```
   git clone git@github.com:<you>/juno-anchors.git /var/lib/juno-runner/juno-anchors-gateway
   ```
4. **Start the gateway.** Runner terminal, with the session file the agent wrote at `/var/lib/juno-runner/gateway-session.json` and its signed grant in `/var/lib/juno-runner/grants/`:
   ```
   /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js gateway serve --session /var/lib/juno-runner/gateway-session.json --socket /var/lib/juno-hook/gateway.sock --journal /var/lib/juno-runner/gateway-journal --anchor /etc/juno/operator.pub --workspace /srv/juno-work --journal-key /var/lib/juno-runner/journal-key --anchors /var/lib/juno-runner/juno-anchors-gateway --git /usr/bin/git --grant /var/lib/juno-runner/grants/<grant file>
   ```
   **Check:** it prints `juno gateway: session gateway-<id> admitted; serving /var/lib/juno-hook/gateway.sock`. Leave this terminal open; **Ctrl+C** stops the gateway (it anchors what is pending as it stops).
5. **Check the separation with the gateway.** Admin terminal: Part G step 4's `hook check`, with ` --gateway juno --shim /opt/juno/dist/mediated/src/juno-mcp.js --gateway-socket /var/lib/juno-hook/gateway.sock` added at the end.
   **Check:** it prints `separated from the runner` and `JUNO's gateway relay juno is the only MCP server Claude Code can load`.

## When something goes wrong

- A check does not show what it says: stop, and send the agent the last 15 lines on screen. Do not work around it.
- The hook service will not start: `journalctl --user -u juno-hook.service --no-pager | tail -20` (runner terminal) lists every refusal.
- Claude Code says JUNO blocked every call: the service is not running (`systemctl --user status juno-hook.service`), or the session was not admitted (Part G step 5). JUNO fails closed: when in doubt, it blocks.
- The anchor repository cannot be reached (no internet, or the push key removed): sessions stop, and the journal records `anchor_failed`. Fix the connection, restart the service, and admit a new session.

## What each part protects, and what it does not

See `docs/evidence/slice-1.5.md` for what Slice 1.5 proves, what each mode does not protect, and every known residual, in plain words.
