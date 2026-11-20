# Operator setup — JUNO on Windows with WSL2

This is the one document for setting JUNO up on your own machine. It collects every step from STATE.md (Parts A to F) and the steps Slice 1.5 added, in the order to do them. Do the parts in order. Every part ends with a **Check**: if a check does not show what it says, stop there and send the agent the last 15 lines on your screen.

**You never paste a secret anywhere.** Every step that creates a credential is marked **Creates a credential**. A password, passphrase or sign-in code is only ever typed or pasted into the program on your own machine that asked for it. Only *public* keys are ever copied: into GitHub, or into a message to the agent. If any step seems to ask you to paste a private key, a passphrase or a token into a website, a chat or a file, stop: that step is wrong.

> **Rules for your Windows account** (D-214). Read these before you start.
>
> Anything that runs as you on Windows can undo everything JUNO does. That means any program, and also any AI agent or coding tool you run on Windows itself (Claude Code, an editor's assistant, a script it writes). Such a program can:
> - ask Windows' key agent to **sign a grant** for itself, whenever your signing key is loaded in that agent; and
> - **start WSL as root** (`wsl -u root`), and from there change JUNO, its journal, its settings and its keys.
>
> JUNO cannot stop either. What you do narrows the window:
> 1. **Your signing key is loaded only to sign.** You load it from your backup just before you sign and remove it straight after (Part B step 6). At every other time, `ssh-add -l` in PowerShell prints `The agent has no identities.`
> 2. **No AI agent or coding tool runs on Windows while your key is loaded.** Better still, run none on Windows at all: run Claude Code only in the governed terminal (Part E), where JUNO governs it.
> 3. **Your key's backup stays off this computer**, and is plugged in only while you sign.
> 4. **Install on Windows only programs you would trust with your signing key.** While the key is loaded, and at any time for WSL's root, a program running as you is trusted like you.
>
> These rules narrow the risk; they do not remove it (`docs/evidence/slice-1.5.md`, items 1 and 3).

What the setup gives you, in plain words:
- A **grant-signing key** kept off this computer and loaded into Windows' key agent only while you sign (Part B). JUNO honours only grants signed with it.
- A WSL2 Ubuntu with three Linux users (Part E): your **admin** user; **`juno-runner`**, which runs JUNO and owns its journal; and **`juno-agent`**, the only user Claude Code runs as.
- A public GitHub repository, **`juno-anchors`**, that receives a fingerprint of JUNO's journal at least once a minute, so a rewrite of history on your machine contradicts a copy that machine cannot take back (Part D). The check that counts is the one you run from your **admin** account against a fresh copy from GitHub (Part G step 7).
- JUNO's **hook service**, which judges every tool call of a Claude Code session you admitted (Part G).

Time: about three hours in total, most of it waiting for installs. You can stop between parts.

How to open the windows this guide uses:
- **PowerShell**: press the Windows key, type `PowerShell`, press Enter. *As administrator*: right-click **Windows PowerShell** and choose **Run as administrator**.
- **Admin terminal** (from Part E on): in PowerShell, type `wsl -d Ubuntu-24.04 -u <your admin name>` and press Enter.
- **Runner terminal** (from Part E on): in PowerShell, type `wsl -d Ubuntu-24.04 -u juno-runner` and press Enter. The prompt starts with `juno-runner@`.
- **Governed terminal** (from Part E step 10 on): Start menu → **Ubuntu 24.04**. It opens as `juno-agent`.

Boxes of commands: paste each box whole into the window named above it and press Enter. If your Windows user name contains a space, stop before Part E step 13 and tell the agent: the `cmd /c` copy lines need a different form for that.

---

## Part A — Windows prerequisites (once, about 20 minutes)

1. Check that the OpenSSH client is present. **PowerShell:** type `Get-Command ssh-keygen` and press Enter. If you see a path ending in `ssh-keygen.exe`, continue. If you see an error: open **Settings → System → Optional features → View features** (Windows 10: **Settings → Apps → Optional features → Add a feature**), search for **OpenSSH Client**, tick it, and click **Install**.
2. **Check OpenSSH's version.** **PowerShell:**
   ```
   ssh -V
   ```
   It prints one line, for example starting `OpenSSH_for_Windows_` and then a version number such as `9.5p1`. **The version must be 8.2 or later** (D-216): JUNO signs with `ssh-keygen -Y sign` and a key held by the agent, which OpenSSH added in 8.1, and 8.1 refuses one option JUNO's signing passes. If the number is older than 8.2: run Windows Update (**Settings → Windows Update → Check for updates**), restart, and run `ssh -V` again. If it is still older than 8.2, **stop**: do not go on to Part B, and send the agent the line `ssh -V` printed.
3. Check that Git and Node.js 22 are installed. **PowerShell:** `git --version` and `node --version` should each print a version, and node's should start with `v22`. If not, install Git for Windows from https://git-scm.com/download/win and Node.js 22 LTS from https://nodejs.org, accepting the defaults, then close and reopen PowerShell.
   **If `node --version` prints another version (for example `v26`) that you use for other work,** do not replace it: JUNO needs 22 (`>=22.13.0 <23`). Put Node.js 22 beside it instead: download the Windows `.zip` of the newest 22.x from https://nodejs.org/dist/, check its SHA-256 against the `SHASUMS256.txt` in the same folder (`Get-FileHash <zip>`), unpack it to a folder such as `C:\Users\<you>\node-v22`, and for every JUNO command in this guide that starts `node` or `npm`/`npx`, run it in a PowerShell where you first typed `$env:Path = "C:\Users\<you>\node-v22;" + $env:Path` (it lasts until that window closes). `node --version` there must print `v22`.
4. **Get JUNO, at the exact version the agent gave you.** The agent gives you a **commit hash**: 40 characters of `0-9` and `a-f`. Every copy of JUNO you install is that commit, and every step that installs one prints the hash for you to compare. The `juno` repository is private: the first command opens a browser window where you sign in to GitHub (Git for Windows does this; nothing is pasted anywhere). **PowerShell**, with `<commit>` replaced by the hash the agent gave you:
   ```
   git clone https://github.com/khashayarjavi/juno.git $env:USERPROFILE\juno
   cd $env:USERPROFILE\juno
   git checkout --detach <commit>
   git rev-parse HEAD
   ```
   `git checkout` prints a note about a "detached HEAD": that is expected (you are on that one commit, not on a branch).
   **Check:** the last line is exactly the hash the agent gave you, all 40 characters. If it differs, stop and tell the agent.
5. **Build JUNO's command on Windows** (it is used only to sign grants), and **pack that exact commit into one file** for WSL (Part E steps 11 and 12 install from it, so WSL never needs your GitHub sign-in). **PowerShell**, still in `$env:USERPROFILE\juno`:
   ```
   npm ci
   npx tsc -p tsconfig.build.json
   git bundle create $env:USERPROFILE\juno.bundle HEAD
   ```
   The last command makes `C:\Users\<you>\juno.bundle`. It holds only JUNO's code, nothing secret.

**Check:** `node $env:USERPROFILE\juno\dist\runner\src\juno.js` prints a line starting `usage: juno grant sign|verify`, and `git -C $env:USERPROFILE\juno rev-parse HEAD` still prints the hash the agent gave you. Write that hash down: Part E compares with it twice.

## Part B — your grant-signing key, kept off this computer (once, about 15 minutes)

**Creates a credential:** your grant-signing key. Its private half is kept on a backup off this computer. It is loaded into Windows' key agent only while you sign, and removed straight after (see "Rules for your Windows account" at the top).

1. *As administrator*, turn on the key agent (it is off by default). **PowerShell (as administrator):**
   ```
   Get-Service ssh-agent | Set-Service -StartupType Automatic
   Start-Service ssh-agent
   Get-Service ssh-agent
   ```
   The last line must say **Running**. Close the administrator window.
2. In a normal PowerShell window, check that the agent holds no key:
   ```
   ssh-add -l
   ```
   It must print `The agent has no identities.` If it lists any key, run `ssh-add -D` (it removes every key the agent holds) and run `ssh-add -l` again.
3. Create the key:
   ```
   ssh-keygen -t ed25519 -C "juno-grant-signing" -f $env:USERPROFILE\.ssh\juno_grant
   ```
   When it asks for a passphrase, type a strong one twice. It does not show what you type. Do not write it anywhere on this computer.
   Do **not** hand it to the agent now.
4. **Move the private key off this computer.** Plug in a USB stick (or another removable drive) that you keep safe. Copy the private key file `C:\Users\<you>\.ssh\juno_grant` (the one **without** `.pub`) onto it; in this guide its place there is called `<backup path>`, for example `E:\juno_grant` if the stick is drive `E:`. **PowerShell** (with your drive letter):
   ```
   Copy-Item $env:USERPROFILE\.ssh\juno_grant E:\juno_grant
   Remove-Item $env:USERPROFILE\.ssh\juno_grant
   ```
   A second copy somewhere else off this computer (for example your password manager's file attachment) is wise; signing uses the USB stick.
5. **Keep** `juno_grant.pub`. It is your public key: the trust anchor JUNO checks every grant against. It is not secret.
6. **How you sign, every time** (Part C and "When something goes wrong" use exactly this):
   1. Plug in the USB stick. **PowerShell:** `ssh-add <backup path>` (for example `ssh-add E:\juno_grant`), and type the passphrase when asked.
   2. Run the `grant sign` command of the step you are in.
   3. Straight after, whether signing worked or not: `ssh-add -D`, then `ssh-add -l`. The last must print `The agent has no identities.` Unplug the USB stick.
   If `ssh-add` refuses the file (for example saying its permissions are too open), stop and send the agent that line; do not change the file's permissions.
7. **Practise the routine once now**, without signing: step 6.1; then `ssh-add -l` lists one line ending in `juno-grant-signing (ED25519)`; then step 6.3.

**Check:** after step 7, `ssh-add -l` prints `The agent has no identities.`, and `Test-Path $env:USERPROFILE\.ssh\juno_grant` prints `False`.

What this protects, and what it does not (D-093, D-214):
- Windows' agent never hands the key out, but **while it holds the key, any program running as you can ask it to sign**. Loading the key only to sign keeps that window to the minutes you sign in.
- **Windows' agent does not keep a key only in memory.** Microsoft's OpenSSH maintainers state that it stores every key added with `ssh-add` in your Windows user's registry, encrypted, and keeps it across restarts until it is removed. So deleting the key file does **not** remove the key from this computer while the agent holds it; `ssh-add -D` removes it from the agent. Whether Windows leaves traces of the encrypted copy on the disk afterwards is not something JUNO or this guide can check.

## Part C — sign your first grant, and check it (about 5 minutes)

A grant is a signed permission: "this principal may use these capabilities, on these paths, until this time". JUNO honours nothing else.

1. Copy the example grant for Claude Code sessions and open it. **PowerShell:**
   ```
   Copy-Item $env:USERPROFILE\juno\docs\examples\grant-claude-code.example.json $env:USERPROFILE\my-grant.json
   notepad $env:USERPROFILE\my-grant.json
   ```
   It lets the session read, list, write and edit files under `/work/project` (that is `/srv/juno-work/project`) and run the read-only programs your session file names, at most 200 times. In Notepad change only two values: `issued_at`, to **yesterday's** date (keep the form `2026-11-08T00:00:00.000Z`; yesterday, because the time is UTC and a grant issued in the future is refused; after a manual recovery, use the time "When something goes wrong" gives instead), and `expires_at`, to the last day it should be valid. Save with **Ctrl+S** and close Notepad.
2. Sign it, with Part B step 6's routine. Plug in the USB stick. **PowerShell** (replace `<backup path>` as in Part B):
   ```
   ssh-add <backup path>
   cd $env:USERPROFILE\juno
   node dist\runner\src\juno.js grant sign --ssh-key $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\my-grant.json --out $env:USERPROFILE\signed-grant.json
   ssh-add -D
   ssh-add -l
   ```
   The `grant sign` line prints `signed grant written to ...`, and the last line prints `The agent has no identities.` Unplug the USB stick. If signing fails, send the agent the failure line and the line `ssh -V` prints.
3. Verify it:
   ```
   node dist\runner\src\juno.js grant verify --anchor $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\signed-grant.json
   ```
4. Optional, to see forgery fail: copy `signed-grant.json` to `forged.json`, open the copy in Notepad, change `"max_invocations": 200` to `201`, save, and run step 3 on `forged.json`. It must print `invalid`. Then delete `forged.json`.

**Check:** step 3 prints `valid`, and `ssh-add -l` prints `The agent has no identities.`

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

   **Where WSL's disk lives** (field report, issue #59). Ubuntu's whole file system is one file, `ext4.vhdx`, on a Windows drive. JUNO's journal is in it, so the drive under it must be an internal disk that is not compressed and has room. **PowerShell** (normal):
   ```
   $d = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss | Get-ItemProperty | Where-Object DistributionName -eq 'Ubuntu-24.04'
   $vhd = Join-Path ($d.BasePath -replace '^\\\\\?\\', '') 'ext4.vhdx'
   $vhd
   (Get-Item $vhd).Attributes
   $part = Get-Partition -DriveLetter $vhd.Substring(0, 1)
   Get-Disk -Number $part.DiskNumber | Format-List FriendlyName, BusType, HealthStatus
   Get-Volume -DriveLetter $vhd.Substring(0, 1) | Format-List FileSystem, SizeRemaining, Size
   ```
   **Check:**
   - `BusType` is `SATA`, `NVMe` or `SAS`. **`USB` is refused, even when Windows calls the drive "Fixed"**: Windows reports most USB disks as Fixed, and WSL then misses its boot deadline. Do not use a USB disk.
   - The `Attributes` line does **not** contain `Compressed`. A compressed disk file makes WSL miss its 10-second boot deadline.
   - `FileSystem` is `NTFS`, `HealthStatus` is `Healthy`, and `SizeRemaining` is at least 30 GB (the disk file grows as JUNO works, and a full drive breaks WSL in ways that look like a broken disk: see "When something goes wrong").
   If a check fails, stop and tell the agent before going on; do not move the disk file yourself.
2. **Turn on systemd.** In the Ubuntu window:
   ```
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```
   Then in **PowerShell**: `wsl --terminate Ubuntu-24.04` (not `wsl --shutdown`, which stops every WSL distribution you have). Wait 10 seconds and open Ubuntu again (Start menu → **Ubuntu 24.04**). Then switch off Canonical's remote-management agent, `landscape-client`, which JUNO does not need and which can hold systemd's start-up forever:
   ```
   sudo systemctl mask --now landscape-client.service
   systemctl is-enabled landscape-client.service
   ```
   **Check** (Ubuntu): the last line prints `masked`; `systemctl is-system-running` prints `running` or `degraded` (if it prints `starting` for more than a minute, run `systemctl list-jobs` and send the agent what it prints); and `stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`.
3. **Install Docker Engine 29.9.2 from Docker's own repository, and git.** Ubuntu:
   ```
   sudo apt update
   sudo apt install -y ca-certificates curl uidmap dbus-user-session git make acl
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
    Windows also keeps its own default user for the distribution, in the registry, and uses it if `/etc/wsl.conf` is ever lost. Make it `juno-agent` too, so that it never falls back to your admin user (which has sudo). **PowerShell** (normal):
    ```
    $uid = wsl -d Ubuntu-24.04 -u root --exec /usr/bin/id -u juno-agent
    $key = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss | Where-Object { (Get-ItemProperty $_.PSPath).DistributionName -eq 'Ubuntu-24.04' }
    Set-ItemProperty $key.PSPath -Name DefaultUid -Value ([int]$uid)
    (Get-ItemProperty $key.PSPath).DefaultUid
    ```
    The last line prints the same number as the first line's `id -u juno-agent`. Then in **PowerShell**: `wsl --terminate Ubuntu-24.04`, wait 10 seconds, and check `wsl --list --running` does not list `Ubuntu-24.04`. Open the **governed terminal** (Start menu → **Ubuntu 24.04**; that entry starts this distribution with its default user, so it opens as `juno-agent`).
    **Check**, in the governed terminal: `whoami` prints `juno-agent`; `findmnt -t drvfs,9p,virtiofs` prints nothing (no Windows drive is mounted; `ls /mnt/c` may print nothing or `No such file or directory`: an empty folder left over from before is harmless); `echo "[$WSL_INTEROP]"` prints `[]`; `sudo -n true` fails; `echo x >> /etc/wsl.conf` prints `Permission denied`. And in **PowerShell**: `wsl.exe -d Ubuntu-24.04 --user juno-runner --exec /usr/bin/id` prints a line with `(juno-runner)`.
11. **Bring JUNO into WSL from the file Part A step 5 made, and run JUNO's rootless checks on your machine.** First copy the file byte for byte into a folder of root's, readable by everyone and changeable only by root (the same copy form as step 13). **PowerShell** (normal):
    ```
    wsl -d Ubuntu-24.04 -u root --exec /usr/bin/install -d -m 0755 /opt/juno-setup
    cmd /c "wsl -d Ubuntu-24.04 -u root --exec /usr/bin/dd of=/opt/juno-setup/juno.bundle status=none < %USERPROFILE%\juno.bundle"
    wsl -d Ubuntu-24.04 -u root --exec /usr/bin/chmod 0444 /opt/juno-setup/juno.bundle
    wsl -d Ubuntu-24.04 -u root --exec /usr/bin/ls -l /opt/juno-setup/juno.bundle
    ```
    **Check:** the last line starts `-r--r--r--` and names `root root`.
    Then, runner terminal. If `~/juno` is there from an earlier attempt, remove it first with `rm -rf ~/juno` (it is only the runner's copy for this check; nothing else uses it):
    ```
    git clone --quiet /opt/juno-setup/juno.bundle ~/juno
    git -C ~/juno rev-parse HEAD
    ```
    The clone prints a note about a "detached HEAD": that is expected.
    **Check:** the second line is exactly the commit hash from Part A step 4, all 40 characters. If it differs, stop and tell the agent. Then:
    ```
    cd ~/juno
    npm ci
    make verify-rootless
    ```
    **Check:** after 10 to 20 minutes the last line is `make verify-rootless: GREEN`. Send the agent the summary lines, or the last 15 lines if it is not green.
    This terminal is a login shell, where Ubuntu lets your group write the files you make (umask `0002`). `make` takes that write access off everything it builds, so the result is the same as in any other terminal (D-219).
12. **A root-owned copy of JUNO, its folders, and the governed workspace.** Admin terminal, first the copy of JUNO, from the same file:
    ```
    sudo git clone --quiet /opt/juno-setup/juno.bundle /opt/juno
    sudo git -C /opt/juno rev-parse HEAD
    ```
    The clone prints a note about a "detached HEAD": that is expected. The second line needs `sudo` because the copy is root's: git refuses to read a repository another user owns.
    **Check:** the second line is exactly the commit hash from Part A step 4. If it differs, stop and tell the agent. Then, admin terminal:
    ```
    cd /opt/juno
    sudo env PATH=/opt/node22/bin:$PATH npm ci --ignore-scripts
    sudo env PATH=/opt/node22/bin:$PATH make build
    sudo install -d -o juno-runner -g juno-runner -m 0700 /var/lib/juno-runner
    sudo install -d -o juno-runner -g juno-runner -m 0700 /var/lib/juno-runner/grants
    sudo install -d -o juno-runner -g juno-hook -m 2750 /var/lib/juno-hook
    sudo install -d -o juno-agent -g juno-agent -m 0755 /srv/juno-work
    sudo install -d -o juno-runner -g juno-runner -m 0700 /var/lib/juno-runner/checkpoints
    sudo setfacl -R -m u:juno-runner:rwX,u:juno-agent:rwX /srv/juno-work
    sudo setfacl -R -d -m u:juno-runner:rwx,u:juno-agent:rwx /srv/juno-work
    ls -ld /opt/juno /opt/juno/dist/mediated/src /opt/juno/dist/mediated/definitions /var/lib/juno-runner /var/lib/juno-hook /srv/juno-work
    getfacl -p /srv/juno-work
    ```
    The two `setfacl` lines give `juno-runner` the right to change everything in the workspace, now and everything created there later, whatever program creates it. That is what lets you undo a session's changes (`juno checkpoint restore`, run as `juno-runner`; see "Undo what Claude did in a session"). JUNO refuses to admit a session with a reversible workspace that `juno-runner` could not restore (D-221).
    `make build` (not `tsc` alone) also copies the capability definitions the hook service needs beside the built code (D-197), and leaves everything it builds writable by root alone (D-219). Then:
    ```
    find /opt/juno /opt/node22 ! -type l -perm /022 -print
    ```
    **Check:** it prints nothing. Anything it prints is a file or folder that someone other than root could change; stop and send the agent the lines. (`juno hook check` in Part G would refuse it too.)
    **Check**, in the listing: `/opt/juno`, its `dist/mediated/src` and `dist/mediated/definitions` start `drwxr-xr-x` and name `root root`; `/var/lib/juno-runner` is `drwx------ juno-runner juno-runner`; `/var/lib/juno-hook` is `drwxr-s--- juno-runner juno-hook`; `/srv/juno-work` is `drwxrwxr-x+ juno-agent juno-agent` (the `+` is the access list). `getfacl` prints, among its lines, `user:juno-runner:rwx`, `user:juno-agent:rwx`, `default:user:juno-runner:rwx` and `default:user:juno-agent:rwx`. Then `stat -f -c %T /srv/juno-work` prints `ext2/ext3` (that is how `stat` names ext4) and `lsattr -d /srv/juno-work` prints a line with no `F` before the path.
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
    **Creates a credential:** Claude Code's sign-in, stored in `juno-agent`'s own home. In the governed terminal run `claude auth login`. Interop is off, so it cannot open a browser for you: it prints a web address. Open that address in your Windows browser, sign in to your Claude account there, and paste the code the page shows back into the governed terminal, where it is waiting for it.
    **Never copy Claude Code's credentials file from Windows** (or from anywhere) into `juno-agent`'s home. Two copies of one sign-in share one refresh token; whichever copy refreshes first makes the other's stop working, often in the middle of a session (`OAuth session expired and could not be refreshed`). The governed terminal has its own sign-in, made by `claude auth login`, and nothing else. When that sign-in expires, run `claude auth login` there again.
    **Check:** `claude auth status` reports that you are logged in, `claude --version` prints `2.1.299` or later, and `which claude` prints a path. Note that path for the next step.
15. **Install JUNO's hook into Claude Code's managed settings.** Admin terminal; replace `<claude path>` with what `which claude` printed:
    ```
    sudo /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook install --socket /var/lib/juno-hook/hook.sock --client /opt/juno/dist/mediated/src/juno-hook.js --node /opt/node22/bin/node --claude <claude path>
    ls -l /etc/claude-code/managed-settings.json
    ```
    **Check:** the install prints `JUNO's hook is installed in /etc/claude-code/managed-settings.json`, then a list of what it cannot control; the `ls` line starts `-rw-r--r--` and names `root root`. (The full separation check comes in Part G, once the hook service runs.)
    From now until Part G step 3 starts the hook service, **Claude Code in the governed terminal is refused every tool call**: the hook fails closed when JUNO is not there to answer. That is expected; nothing is broken. This installation is yours to run: an AI agent helping you is right to refuse to install or change the hook that governs it.

**Check for Part E as a whole:** steps 10, 11, 12 and 15 each showed what they say: the governed terminal opens as `juno-agent` with no Windows drives, both copies of JUNO in WSL (`~/juno` and `/opt/juno`) are the commit the agent gave you, `make verify-rootless` is GREEN on your machine, the folders have the owners and modes listed, and the hook is installed in root's managed settings.

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
5. **Check the push key reaches GitHub.** Runner terminal:
   ```
   ssh -T git@github.com
   ```
   The first time, it asks whether to trust GitHub's host key and shows a fingerprint. Open GitHub's page "GitHub's SSH key fingerprints" (docs.github.com, search for that title) and compare the fingerprint shown with the one listed there for ED25519; type `yes` only if they match exactly. It then prints `Hi <you>/juno-anchors! You've successfully authenticated, but GitHub does not provide shell access.` Keep GitHub's page open for the next step. (You do not clone the repository: JUNO keeps its own copy and rebuilds it from GitHub at every start.)
6. **Check the protection without touching history.** On GitHub: **Settings → Rules → Rulesets → protect-history** shows **Active**, the default branch as target, and both protections ticked. Do not try to delete or force-push anything to test it.
7. **Pin the repository where `juno-runner` cannot change it (D-206, D-208).** Which repository JUNO anchors to, and which server it believes is GitHub, are written in two files that belong to root. `juno-runner` can read them and cannot change them, so nothing that takes over `juno-runner` can point JUNO at another repository.
   GitHub's host key is taken from two places that must agree in full: the key the server offers to `ssh`, and the key GitHub publishes at `https://api.github.com/meta`. (`ssh-keyscan` is not used: it cannot complete the key exchange GitHub now prefers, `sntrup761x25519-sha512@openssh.com`, on any machine, so it returns no key. GitHub's greeting line, `SSH-2.0-` and then a word, changes from time to time; it proves nothing and nothing here checks it.)
   First, see the key GitHub offers, **without trusting it**. Admin terminal:
   ```
   install -d -m 0700 ~/juno-hostkey
   cd ~/juno-hostkey
   ssh -vv -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes -T git@github.com 2>&1 | grep -e 'Server host key:' -e 'Host key verification failed'
   ```
   **Check:** two lines: `debug1: Server host key: ssh-ed25519 SHA256:` followed by 43 characters, and `Host key verification failed.` The second line is `ssh` refusing a key it does not know: nothing was trusted or written. Compare the `SHA256:...` text, character by character, with the ED25519 fingerprint on GitHub's page from step 5. **If they differ, stop and tell the agent.**
   Then capture the whole key `ssh` is offered into a scratch file of your own (used for nothing but this comparison), and the whole key GitHub publishes:
   ```
   ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/juno-hostkey/scratch_known_hosts -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes -o PubkeyAuthentication=no -T git@github.com
   awk '{print $2" "$3}' scratch_known_hosts > offered.txt
   curl -fsS https://api.github.com/meta -o meta.json
   /opt/node22/bin/node -e 'const m = JSON.parse(require("fs").readFileSync("meta.json", "utf8")); const keys = m.ssh_keys.filter((k) => k.startsWith("ssh-ed25519 ")); if (keys.length !== 1) process.exit(1); console.log(keys[0]); console.error(m.ssh_key_fingerprints.SHA256_ED25519);' > published.txt
   cat offered.txt published.txt
   cmp offered.txt published.txt && echo "the same key"
   ```
   The first command ends with `git@github.com: Permission denied (publickey).`: expected (your admin user has no key there). **Check:** the `node` line prints the published fingerprint, the same `SHA256:...` as above; then two identical lines, each `ssh-ed25519 AAAA...`; then `the same key`. If `cmp` reports a difference, or `node` prints nothing, **stop and tell the agent**.
   Then pin that key, and let `ssh` itself check, against the whole pinned key, that GitHub holds it:
   ```
   printf 'github.com %s\n' "$(cat published.txt)" | sudo tee /etc/juno/anchors_known_hosts
   ssh-keygen -lf /etc/juno/anchors_known_hosts
   ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/juno/anchors_known_hosts -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o BatchMode=yes -o PubkeyAuthentication=no -T git@github.com
   ```
   **Check:** `ssh-keygen` prints a line containing the same `SHA256:...`; the last command prints `git@github.com: Permission denied (publickey).` (GitHub proved it holds the pinned key). If it prints `Host key verification failed.`, **stop and tell the agent.** Select the whole `SHA256:...` text and copy it. Then:
   ```
   sudo cp /opt/juno/docs/examples/anchors.example.json /etc/juno/anchors.json
   sudo nano /etc/juno/anchors.json
   ```
   In nano, change three things and nothing else:
   - in `url`, replace `<you>` with your GitHub user name;
   - replace the whole `<the ED25519 fingerprint ...>` text with the `SHA256:...` you copied;
   - replace the whole `<an early date: ...>` text with exactly `2020-01-01T00:00:00Z`. This is the journal's *recovery epoch*: JUNO refuses, on this journal, every grant whose `issued_at` is earlier. Your first grant (Part C) is issued after it whenever you do Part C and Part D, and your signing key is new (Part B), so no grant of yours from before it exists.
   Leave the `git` line as it is (`/usr/bin/git`). It is the only place that names the git program JUNO uses for `juno-anchors`; the service's own settings cannot name one.
   Save with **Ctrl+O**, Enter, and leave with **Ctrl+X**. Then:
   ```
   sudo chown root:root /etc/juno/anchors.json /etc/juno/anchors_known_hosts
   sudo chmod 0644 /etc/juno/anchors.json /etc/juno/anchors_known_hosts
   ```

**Check:** step 5's `ssh -T` line names `juno-anchors`. `ls -l /etc/juno/anchors.json /etc/juno/anchors_known_hosts` shows `root root` and `-rw-r--r--` on both lines. `ls -l /usr/bin/git /usr/bin/ssh` shows `root root` and `-rwxr-xr-x` on both lines. Part G step 4's `juno hook check` judges both files again and says so.

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
   Keep `"reversible_workspaces": ["/work/project"]`: JUNO copies that folder when it admits the session and lets Claude create and change files inside it, because you can undo them ("Undo what Claude did in a session", below). **Without it, every write is parked** (`integrity_floor`, which nobody can override): Claude can read the project but not change it.
3. **Start the service.** **Creates a credential:** on its first start the service makes JUNO's journal key (`/var/lib/juno-runner/journal-key`, readable by `juno-runner` only), which signs every anchor. It is not your grant-signing key, and you never handle it. Runner terminal:
   ```
   mkdir -p ~/.config/systemd/user
   cp /opt/juno/docs/examples/juno-hook.service ~/.config/systemd/user/juno-hook.service
   systemctl --user daemon-reload
   systemctl --user enable --now juno-hook.service
   systemctl --user status juno-hook.service --no-pager
   ```
   **Check:** the status shows `active (running)` and a line `juno hook: serving /var/lib/juno-hook/hook.sock`. If it shows `inactive` or `failed`, run `journalctl --user -u juno-hook.service --no-pager | tail -20`: it lists every refusal in plain words. Send them to the agent.
   **GitHub must be reachable every time the service starts, not only today.** At every start the service reads `juno-anchors` from GitHub over SSH (port 22) to check its journal, and refuses to start if it cannot (for example `Could not resolve hostname github.com`). There is no offline mode: on a plane, behind a captive portal, or while the network is changing, the service does not start, and Claude Code is refused every call until it does. A VPN is not needed: on your machine the service started and anchored with the VPN switched off (issue #59). When it refuses for this reason, fix the connection and run `systemctl --user restart juno-hook.service`.
   (`/var/lib/juno-runner/juno-anchors` has no git "remote" set: `git remote -v` in it prints nothing. That is deliberate (D-208): the service gives git the address from root's `/etc/juno/anchors.json` every time and trusts nothing stored in that folder. Do not add a remote.)
4. **Check the separation** (D-173). Admin terminal:
   ```
   sudo /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js hook check --agent-user juno-agent --runner-user juno-runner --socket /var/lib/juno-hook/hook.sock --client /opt/juno/dist/mediated/src/juno-hook.js --node /opt/node22/bin/node --state /var/lib/juno-runner --workspace /srv/juno-work --anchor /etc/juno/operator.pub
   ```
   **Check:** it prints `separated from the runner`, `case-sensitive Linux file system`, and `The anchor repository and its host key are pinned in root's own file`. If it refuses with a line about `the anchor pin`, redo Part D step 7 and send the agent the refusal line if it stays.
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
7. **Check the journal against what GitHub holds, from your admin account (D-214).** This is the check that counts. It runs as your **admin** user, not as `juno-runner` (whose account is inside what is being checked: it owns its settings, its environment and its own copy of `juno-anchors`) and not as root. It uses a fresh copy of `juno-anchors` taken from GitHub by you, a copy of the journal made by root, a clean environment, and only `/opt/node22` and `/opt/juno`, which are root's.
   After you finish the session, first in the **runner terminal** (stopping the service anchors what is pending):
   ```
   systemctl --user stop juno-hook.service
   ```
   Then in the **admin terminal** (replace `<you>` with your GitHub user name):
   ```
   install -d -m 0700 ~/juno-check
   rm -rf ~/juno-check/anchors ~/juno-check/journal ~/juno-check/journal-key.pub.pem
   git clone --quiet https://github.com/<you>/juno-anchors.git ~/juno-check/anchors
   sudo cp -RP /var/lib/juno-runner/journal ~/juno-check/journal
   sudo cp -P /var/lib/juno-runner/journal-key/journal-key.pub.pem ~/juno-check/journal-key.pub.pem
   sudo chown -hR "$(id -un):$(id -gn)" ~/juno-check/journal ~/juno-check/journal-key.pub.pem
   ```
   Then, still in the admin terminal, with `<task id>` replaced by the last word of step 5's `Check its journal with:` line (it starts `session-`):
   ```
   env -i /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js journal check --journal ~/juno-check/journal --anchors ~/juno-check/anchors --key ~/juno-check/journal-key.pub.pem <task id>
   ```
   **Check:** it prints JSON with `"ok": true`, `"unanchored": 0` and `"history": "checked"`. Then start the service again, in the runner terminal: `systemctl --user start juno-hook.service`.
   The check also reads the history of your fresh copy of `juno-anchors`: if any commit ever removed, changed or renamed an anchor file, it refuses with `"anchor_history"` (D-217). That is what an attacker holding the push key would have to do to make a forged journal agree. **Do not delete anything**; send the agent the lines it printed. Do not clone with `--depth`: a shallow copy is refused, because its history is not all there.
   (`/var/lib/juno-runner/juno-anchors` is only JUNO's own copy of the repository; JUNO rebuilds it from GitHub at every start and never trusts it, and this check never reads it. A check run as `juno-runner` does not count.)

A session JUNO did not admit is denied every call. **One admitted session is one Claude Code run.** Claude Code takes the session id for the first `claude` started with it; a second `claude --session-id` with the same id fails with `Session ID ... is already in use`. So each new Claude Code run needs its own `session_id` (step 2) and its own `juno hook admit` (step 5).

**What a restart does (D-201).** Every time the service starts, it first checks its whole journal against the anchors in `juno-anchors`. Then it rebuilds everything from the journal. So after a restart:
- a session you admitted earlier is still admitted, with the tool calls and time it had already used; you do not admit it again, and JUNO refuses if you try (`is already admitted`);
- every grant keeps the number of uses it already had;
- a new piece of work still needs a new `session_id` and a new `juno hook admit`.

If the journal was changed, cut or deleted, if an anchor disagrees with it, or if `juno-anchors` cannot be reached, **the service refuses to start** and says which record and why (see "When something goes wrong").

**What every start checks against GitHub (D-206, D-208).** At every start the service fetches `juno-anchors` afresh from the address in `/etc/juno/anchors.json`, accepting only the server whose key is in `/etc/juno/anchors_known_hosts`. It compares its own copy (`/var/lib/juno-runner/juno-anchors`), its journal and its settings with what GitHub holds:
- a copy that is not a copy of your repository, or that holds anything but anchors GitHub lacks, refuses the start;
- a journal folder that `/etc/juno/anchors.json` does not name refuses the start. Only you, as root, add one there;
- an empty or different journal where GitHub holds anchors of the journal that was there refuses the start.
So replacing the journal, the copy and the service's settings together does not make the service start as new.

**Who JUNO trusts on this machine (D-211, D-214).** The `juno-runner` account is part of JUNO itself: the service runs as it and holds its journal. Someone who takes over that account can disturb JUNO on this machine. They still cannot sign a grant (your signing key is off this computer except while you sign, Part B), and they cannot erase what is already in `juno-anchors` without trace (GitHub keeps every commit, and both the service and your check refuse a history that ever removed or changed an anchor file, D-204, D-217). Your check from the admin account against a fresh copy from GitHub (Part G step 7) is what shows it. So never log in as `juno-runner` for anything but the steps in this guide, and never give anyone its password.

**One failure is repaired for you: a power loss in the middle of a write (D-206).** If the machine lost power, or the service was killed, while it was writing the last line of the journal, the next start finds that last line incomplete. If everything before it verifies and agrees with GitHub, the service drops the incomplete line, records that it did (`recovered_truncation`), and starts. It then prints a line beginning `the journal's last entry was left incomplete` (where to find it, and what to do: "When something goes wrong"), and **every grant used by a session that was open at that moment is exhausted for good**: its calls are refused until you sign a new grant (Part C, with a new `id`) and admit a new session under it. This is deliberate: JUNO cannot know whether the lost line was a use of one of those grants.

## Undo what Claude did in a session (restore a checkpoint)

When JUNO admits a session with `reversible_workspaces` (Part G step 2), it copies each of those folders first: the **checkpoint**, in `/var/lib/juno-runner/checkpoints`, listed in the journal. Restoring it puts the folder back exactly as it was then: files Claude created are removed, files it changed or deleted come back, and the restore is written into the journal under your name (§2.2.2, D-221). It is for the whole folder, never one file.

An empty project gives an empty checkpoint: if `/srv/juno-work/project` held nothing when you admitted the session, the checkpoint store gains nothing, and restoring it empties the folder again. That is correct, not a fault.

1. **Stop the service.** Runner terminal: `systemctl --user stop juno-hook.service`. (The restore refuses while it runs: `the journal is in use, so its service is running`. Claude Code is refused every call meanwhile.)
2. **Find the checkpoint.** Runner terminal, with `<task id>` the `session-...` word `hook admit` printed (Part G step 5):
   ```
   /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js checkpoint list --journal /var/lib/juno-runner/journal <task id>
   ```
   It prints each checkpoint (`checkpoint`, 64 characters), its folder (`root`, for example `/work/project`), `workspace` (`/srv/juno-work`), when it was taken, and every restore already done.
3. **Restore it.** Runner terminal (as `juno-runner`, never with `sudo`; replace `<principal>` with the `principal` of your session file, `<task id>` and `<checkpoint>` as in step 2):
   ```
   /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js checkpoint restore --journal /var/lib/juno-runner/journal --checkpoints /var/lib/juno-runner/checkpoints --workspace /srv/juno-work --principal <principal> <task id> <checkpoint>
   ```
   **Check:** it prints `"ok": true` and the folder. If it prints `"ok": false`, read the `reason`; a reason ending `nothing was changed` changed nothing. The most common one, `juno-runner cannot read, change and enter ...`, means a folder in the workspace lost the access list of Part E step 12; run that step's two `setfacl` lines again (admin terminal) and restore again.
4. **Start the service again:** `systemctl --user start juno-hook.service`. The session goes on, with what it had used.

A checkpoint taken by a JUNO from before this version (commit 6706b5a and earlier) does not record its folder, and the restore refuses it (`does not record the host folder it was taken in`). Sessions admitted after the upgrade are restorable.

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
   **Check:** the last line prints `1`, and `systemctl --user status juno-hook.service --no-pager` shows `active (running)`. Sessions you admitted before the restart are still admitted, with what they had already used (D-201); do not admit them again.
3. **Add the gateway's journal folder to the pin.** The gateway keeps a journal of its own, and a journal folder may anchor only if `/etc/juno/anchors.json` names it. Admin terminal:
   ```
   sudo nano /etc/juno/anchors.json
   ```
   In the `journals` list, after the line for `/var/lib/juno-runner/journal`, add a comma at the end of that line and then a new line: `{ "path": "/var/lib/juno-runner/gateway-journal", "recovery_epoch": "<the same time as the line above>" }`. Save with **Ctrl+O**, Enter, **Ctrl+X**. (The gateway makes its own copy of `juno-anchors`; you do not clone anything.)
4. **Start the gateway.** Runner terminal, with the session file the agent wrote at `/var/lib/juno-runner/gateway-session.json` and its signed grant in `/var/lib/juno-runner/grants/`:
   ```
   /opt/node22/bin/node /opt/juno/dist/runner/src/juno.js gateway serve --session /var/lib/juno-runner/gateway-session.json --socket /var/lib/juno-hook/gateway.sock --journal /var/lib/juno-runner/gateway-journal --anchor /etc/juno/operator.pub --workspace /srv/juno-work --journal-key /var/lib/juno-runner/journal-key --anchors /var/lib/juno-runner/juno-anchors-gateway --anchor-pin /etc/juno/anchors.json --grant /var/lib/juno-runner/grants/<grant file>
   ```
   **Check:** it prints `juno gateway: session gateway-<id> admitted; serving /var/lib/juno-hook/gateway.sock`. Leave this terminal open; **Ctrl+C** stops the gateway (it anchors what is pending as it stops).
   When you start the gateway again with the same session file, it prints `was admitted before this start; it goes on from its journal` instead: the same session continues with the calls and time it had already used (D-201). To begin a fresh gateway session, ask the agent for a session file with a new `session_id`; a changed file under the old id is refused.
5. **Check the separation with the gateway.** Admin terminal: Part G step 4's `hook check`, with ` --state /var/lib/juno-runner/gateway-journal --gateway juno --shim /opt/juno/dist/mediated/src/juno-mcp.js --gateway-socket /var/lib/juno-hook/gateway.sock` added at the end.
   **Check:** it prints `separated from the runner` and `JUNO's gateway relay juno is the only MCP server Claude Code can load`.

A gateway session has no reversible workspace: the MCP server makes its own changes, outside any folder JUNO can copy, so every write through the gateway is judged irreversible and parks unless its grant names the exact target. There is nothing to restore for it (D-221).

## Upgrading JUNO to a new commit

For a machine where JUNO is already installed (Parts A to G done). The agent gives you the new **commit hash**. The upgrade replaces only JUNO's code: `/opt/juno` (root's copy) and `~/juno` (the runner's copy for its checks). **It keeps everything else**: the journal, grants, checkpoints, journal key and session files in `/var/lib/juno-runner`, root's files in `/etc/juno`, the service file in `~juno-runner/.config/systemd/user`, and `juno-anchors` on GitHub. Never delete any of those to upgrade. CI proves this on every change: the new service starts on the journal the old one wrote, and its sessions go on (D-222).

1. **Windows: the new commit, built and packed.** **PowerShell**, with `<commit>` the new hash:
   ```
   cd $env:USERPROFILE\juno
   git fetch
   git checkout --detach <commit>
   git rev-parse HEAD
   npm ci
   npx tsc -p tsconfig.build.json
   Remove-Item $env:USERPROFILE\juno.bundle
   git bundle create $env:USERPROFILE\juno.bundle HEAD
   ```
   **Check:** `git rev-parse HEAD` prints exactly the new hash.
2. **Copy the bundle into WSL** (it replaces the old one). **PowerShell** (normal):
   ```
   cmd /c "wsl -d Ubuntu-24.04 -u root --exec /usr/bin/dd of=/opt/juno-setup/juno.bundle status=none < %USERPROFILE%\juno.bundle"
   wsl -d Ubuntu-24.04 -u root --exec /usr/bin/chmod 0444 /opt/juno-setup/juno.bundle
   ```
3. **Stop JUNO.** Runner terminal: `systemctl --user stop juno-hook.service` (it anchors what is pending as it stops). If the gateway runs (Part H), stop it with **Ctrl+C** in its terminal.
4. **The runner's copy, and the checks on your machine.** Runner terminal:
   ```
   rm -rf ~/juno
   git clone --quiet /opt/juno-setup/juno.bundle ~/juno
   git -C ~/juno rev-parse HEAD
   cd ~/juno
   npm ci
   make verify-rootless
   ```
   **Check:** the hash is the new one, and after 10 to 20 minutes the last line is `make verify-rootless: GREEN`.
5. **Root's copy.** Admin terminal:
   ```
   sudo rm -rf /opt/juno
   sudo git clone --quiet /opt/juno-setup/juno.bundle /opt/juno
   sudo git -C /opt/juno rev-parse HEAD
   cd /opt/juno
   sudo env PATH=/opt/node22/bin:$PATH npm ci --ignore-scripts
   sudo env PATH=/opt/node22/bin:$PATH make build
   find /opt/juno /opt/node22 ! -type l -perm /022 -print
   ```
   **Check:** the hash is the new one, and the `find` line prints nothing (as in Part E step 12).
6. **Once, for the upgrade from 6706b5a (or earlier) only: the workspace's access list.** Admin terminal:
   ```
   sudo apt install -y acl
   sudo setfacl -R -m u:juno-runner:rwX,u:juno-agent:rwX /srv/juno-work
   sudo setfacl -R -d -m u:juno-runner:rwx,u:juno-agent:rwx /srv/juno-work
   getfacl -p /srv/juno-work
   ```
   **Check:** as in Part E step 12. Without it, a session with `reversible_workspaces` is refused at admission (`could not be restored by the runner`).
7. **Check the separation**, admin terminal: Part G step 4's `hook check`. **Check:** as there.
8. **Start JUNO again.** Runner terminal:
   ```
   systemctl --user start juno-hook.service
   systemctl --user status juno-hook.service --no-pager
   ```
   **Check:** `active (running)` and `juno hook: serving /var/lib/juno-hook/hook.sock`; if sessions were admitted before, also a line saying they `go on from the journal`. If it refuses, send the agent `journalctl --user -u juno-hook.service --no-pager | tail -20`; do not delete anything.
   If you use the gateway, start it again with Part H step 4's command.

If the agent's note for the new commit says the example service file changed, also copy it again (Part G step 3's `cp` and `daemon-reload`) before step 8.

## When something goes wrong

- A check does not show what it says: stop, and send the agent the last 15 lines on screen. Do not work around it.
- The hook service will not start: `journalctl --user -u juno-hook.service --no-pager | tail -20` (runner terminal) lists every refusal.
- Claude Code says JUNO blocked every call: the service is not running (`systemctl --user status juno-hook.service`), or the session was not admitted (Part G step 5). JUNO fails closed: when in doubt, it blocks.
- **WSL suddenly shows `Bus error`, `Input/output error`, or commands such as `rm` and `which` "not found".** Check free space on the Windows drive that holds WSL's disk file **first** (File Explorer → This PC, or Part E step 1's check): a full drive makes every write in WSL fail in exactly these ways. Free space on that drive, then `wsl --terminate Ubuntu-24.04` and open it again. Do **not** run `e2fsck` or any repair before checking the space, and send the agent what you saw. On your machine, a full `C:` produced all of these and the file system was undamaged.
- **Claude Code says `OAuth session expired`**: its own sign-in in the governed terminal ran out. Run `claude auth login` there again (Part E step 14). Never copy a credentials file in.
- The anchor repository cannot be reached (no internet, or the push key removed): sessions stop, and the journal records `anchor_failed`. A stopped session stays stopped. Fix the connection, restart the service (it starts again on the same journal once the repository can be reached), and admit a new session with a new `session_id`. While the repository cannot be reached the service does not start at all.
- **A power loss or a crash interrupted one journal write** (D-206, D-214). The hook service or the gateway repairs it, records it and keeps running. **Where you see it:**
  - **Hook service:** runner terminal, `systemctl --user status juno-hook.service --no-pager` shows it among its last lines, and `journalctl --user -u juno-hook.service --no-pager | tail -20` shows it in full. The line starts `juno hook: the journal's last entry was left incomplete`.
  - **Gateway (Part H):** in the terminal where you started `juno gateway serve`, a line starting `juno gateway: the journal's last entry was left incomplete`.

  The grants named at the end of that line, after `exhausted`, are refused from now on. To go on working, sign a new grant for each of them (example for the first grant; for another, use its name in place of `grant-operator-first`, and for the gateway, the grant file the agent wrote for it in place of `my-grant.json`):
  1. **The date for the new grant.** The rule: a grant's `issued_at` must be **at or after the recovery epoch** of the journal it is used on (the `recovery_epoch` on that journal's line in `/etc/juno/anchors.json`) **and in the past**. Admin terminal:
     ```
     date -u +%Y-%m-%dT%H:%M:%S.000Z
     ```
     It prints the time now, in the form a grant uses. That is a safe value: every recovery epoch you set was a time printed earlier, so it is not before any of them, and by the time you sign it is in the past. Copy it. (Not "yesterday": after a manual recovery, yesterday can be before the journal's recovery epoch, and is refused.)
  2. **PowerShell:** make a copy of your grant under a new name and open it:
     ```
     Copy-Item $env:USERPROFILE\my-grant.json $env:USERPROFILE\my-grant-2.json
     notepad $env:USERPROFILE\my-grant-2.json
     ```
     Change three values: `id`, from `grant-operator-first` to `grant-operator-2` (each later time, the next number: `-3`, `-4`); `issued_at`, to the time you copied in step 1; and `expires_at` if you want. Save with **Ctrl+S** and close Notepad.
  3. **PowerShell**, in `$env:USERPROFILE\juno`: sign it with Part B step 6's routine and check it, as in Part C steps 2 and 3, with the new names. Plug in the USB stick, then:
     ```
     ssh-add <backup path>
     node dist\runner\src\juno.js grant sign --ssh-key $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\my-grant-2.json --out $env:USERPROFILE\signed-grant-2.json
     ssh-add -D
     ssh-add -l
     node dist\runner\src\juno.js grant verify --anchor $env:USERPROFILE\.ssh\juno_grant.pub $env:USERPROFILE\signed-grant-2.json
     ```
     **Check:** `ssh-add -l` prints `The agent has no identities.`, and the last line prints `valid`. Unplug the USB stick.
  4. **PowerShell** (normal): copy it in, as in Part G step 1, under its new name:
     ```
     cmd /c "wsl -d Ubuntu-24.04 -u juno-runner --exec /usr/bin/dd of=/var/lib/juno-runner/grants/grant-operator-2.json status=none < %USERPROFILE%\signed-grant-2.json"
     wsl -d Ubuntu-24.04 -u juno-runner --exec /usr/bin/chmod 0600 /var/lib/juno-runner/grants/grant-operator-2.json
     ```
  5. Runner terminal: `cat /proc/sys/kernel/random/uuid` and copy what it prints. Then the session file:
     - **Hook service:** `nano /var/lib/juno-runner/session.json`. Change three things: `session_id` to the UUID you copied; in `"grants": ["grant-operator-first"]`, the name to `grant-operator-2`; and at the bottom, `/var/lib/juno-runner/grants/grant-operator-first.json` to `/var/lib/juno-runner/grants/grant-operator-2.json`. Save with **Ctrl+O**, Enter, and leave with **Ctrl+X**.
     - **Gateway:** `nano /var/lib/juno-runner/gateway-session.json`. Change two things: `session_id` to the UUID you copied, and in `"grants": [...]` the old grant's name to `grant-operator-2`. Save and leave as above.
  6. **Hook service:** admit it and work as in Part G steps 5 and 6. **Gateway:** stop it with **Ctrl+C** if it is still running, and start it again with Part H step 4's command, with `--grant /var/lib/juno-runner/grants/grant-operator-2.json` in place of the old `--grant` file.

  **Check:** for the hook, step 6's `hook admit` prints `admitted`; for the gateway, it prints `juno gateway: session gateway-<the new UUID> admitted`. Then a call inside the new grant is allowed. If admission says the grant `was issued before this journal's recovery epoch`, redo steps 1 to 4. If JUNO blocks calls naming `exhausted`, step 2's `id` was not changed; naming `not_yet_issued`, the time from step 1 is still ahead of the service's clock: wait a minute and try again.
- The service refuses to start saying `the anchor repository's history removes or changes` an anchor file: someone with the push key committed a deletion or a change to `juno-anchors`. GitHub keeps that commit for good, so JUNO will not trust that repository again. **Do not delete anything.** Send the agent the refusal lines; the way on is a new anchor repository (Part D again, under a new name, with a new `/etc/juno/anchors.json`) and a manual recovery (below), with the old ones kept as evidence.
- The service refuses to start saying `the local anchor clone ... disagrees with the pinned repository`: the folder `/var/lib/juno-runner/juno-anchors` is not a copy of your `juno-anchors`. **Do not delete it.** Send the agent the refusal lines. JUNO did not write that; something else on the machine did.
- The service refuses to start saying `is not a journal folder the anchor pin ... names`, or a line about `the anchor pin`: the service's settings name a journal folder, or a pin file, that you did not set up as root. If you did not change `~/.config/systemd/user/juno-hook.service` yourself, send the agent the refusal lines before changing anything.
- The service refuses to start and names a journal record that `does not verify`, `disagrees with its off-host anchors`, `has no readable payload`, or `is not named by the journal's own record`: the journal on this machine is not the one JUNO wrote and anchored. **Do not delete or repair anything.** Send the agent the refusal lines. JUNO will not start on that journal again. The same refusal (`the anchor pin names a recovery epoch for this journal ... but the journal records none`) appears for a journal folder written by a JUNO version from before 2026-11-13. The way on, in both cases, is a **manual recovery** (D-206):
  1. Keep the old journal folder as evidence. Never move or rename it.
  2. Admin terminal: `date -u +%Y-%m-%dT%H:%M:%SZ` prints the time now; copy it. Then `sudo nano /etc/juno/anchors.json` and add a new line to the `journals` list (a comma after the line before it): `{ "path": "/var/lib/juno-runner/journal-2", "recovery_epoch": "<the time you copied>" }`. Save and leave. Only root can do this step; that is what makes the recovery your act.
  3. Runner terminal: in `~/.config/systemd/user/juno-hook.service` change `--journal /var/lib/juno-runner/journal` to `--journal /var/lib/juno-runner/journal-2`, then `systemctl --user daemon-reload` and `systemctl --user start juno-hook.service`.
  4. **Every grant issued before that time is now refused** on the new journal (`was issued before this journal's recovery epoch`). Make new grants as in Part C, with one change: set `issued_at` to **the time you copied in step 2** (not yesterday: yesterday is before the recovery, and would be refused). Sign them, check them (Part C steps 2 and 3), and copy them in (Part G step 1).
  5. Use new `session_id`s (Part G step 2). A session id that was used on the old journal cannot be used again: its fingerprints are already in `juno-anchors`, and JUNO never replaces one.

## What each part protects, and what it does not

See `docs/evidence/slice-1.5.md` for what Slice 1.5 proves, what each mode does not protect, and every known residual, in plain words.
