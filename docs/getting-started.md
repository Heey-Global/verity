# Getting started with Verity

This guide takes you from nothing to your first running coding-agent session.
It assumes no server experience. Plan for about 30 minutes, most of it waiting
for downloads.

Verity has two parts. The **Core** is the server you install once on a Linux
machine; it runs your projects and your agents. The **app** is how you talk to
it: in a browser, on an iPhone, or on an iPad. You can use any or all of them.

## What you need

- **A Linux machine that stays switched on**, with Docker 25 or newer. This is
  where your projects and agents run. A Mac or Windows laptop alone is not
  enough. If you do not have one, [rent a small cloud server](#where-to-run-verity)
  for roughly the price of a streaming subscription.
- **A subscription for one AI provider.** Verity signs in with your existing
  account, so an agent's work is billed to that subscription, not to Verity:
  - Claude (Anthropic) for Claude Code, or
  - ChatGPT (OpenAI) for Codex, or
  - any OpenAI-compatible API key for open-source models through OpenCode.
- **A way to use the app.** A current browser works on any computer and needs
  no invitation. For the iPhone or iPad app, request a TestFlight invitation
  from [hello@verity.build](mailto:hello@verity.build). TestFlight is Apple's
  app for installing beta versions.

That is the whole list. A GitHub account is useful later, but you do not need
it to start.

## Where to run Verity

Verity needs a Linux machine with Docker that is reachable from your phone or
browser. Pick one of these:

**You already have a Linux machine.** A home server, a mini PC, or a Linux
workstation works if Docker 25 or newer and the Docker Compose plugin are
installed. Check with `docker --version` and `docker compose version`.

**You rent a cloud server.** This is the simplest path when you start from a
Mac or Windows laptop:

1. Create an account at a cloud provider, for example Hetzner Cloud or
   DigitalOcean. Both offer ready-made server images with Docker preinstalled;
   look for "Docker" in the app or marketplace catalog when creating the
   server. Choose Ubuntu as the operating system if asked.
2. Pick a size with **16 GB of memory and 4 CPU cores**. That runs one project
   comfortably. Expect roughly 20 to 30 euros a month at Hetzner and more at
   larger providers; prices change, so check the provider. A machine with
   8 GB works for light use once you lower the
   [sandbox memory limit](../deploy/README.md#resource-guardrails) after
   installing.
3. Add your SSH key when the provider asks, or let it email you a root
   password. SSH is the secure remote terminal you use to type commands on the
   server.
4. Open a terminal on your laptop (Terminal on macOS, Windows Terminal on
   Windows) and connect:

   ```sh
   ssh root@<the server's IP address>
   ```

   Answer `yes` when asked whether to trust the new host. You now type commands
   on the server.

**Keep the server private.** A rented server is reachable from the whole
internet, and Verity's ports must not be. The simplest fix is Tailscale, a free
private network between your devices:

1. On the server, run the Tailscale installer and sign in with the link it
   prints:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. Install the Tailscale app on the phone, tablet, or computer you will use
   Verity from, and sign in with the same account.
3. Note the server's Tailscale address, which starts with `100.`, from
   `tailscale ip -4`. You will enter it during installation.
4. In your cloud provider's firewall, allow only SSH (port 22) and Tailscale
   (UDP port 41641) from the internet. Verity's ports 8082 and 8100 to 8119 must
   stay closed to the public; see the
   [hardening guide](../deploy/README.md#hardening-an-internet-reachable-host)
   for the details behind this.

A machine on your home network that you only use from the same network does
not need this step. If you rely on a firewall on the machine itself, such as
ufw, know that it does not block Verity's ports: Docker publishes them before
those rules apply. Block them on the router or network instead, and check from
outside that they are closed.

## Step 1: Install the Core

On the server, run:

```sh
curl -fsSL https://verity.build/install.sh | bash
```

This downloads the Verity installer and runs it with your permissions. It
checks the machine, downloads the signed Verity release, and starts it with
Docker. It does not install Docker itself. To see what it would do without
changing anything, run the same command with `--preflight` at the end:

```sh
curl -fsSL https://verity.build/install.sh | bash -s -- --preflight
```

The installer prints four numbered steps. When it asks
**"Choose the address this phone will use to reach Verity"**, pick the address
your devices can reach: the Tailscale address from above, or the local network
address of a machine at home. You can also choose "Enter an IP address or DNS
name" and type it.

**What you should see:** a QR code, the same pairing link as text starting with
`verity://pair?`, and the line "Installation complete". The pairing link is
valid for 15 minutes. If it expires, run the install command again and choose
"Repair this installation"; it prints a new one.

Keep this terminal open for the next step.

## Step 2: Connect your first device

Choose one. You can add the others later.

**In a browser:**

1. Open `https://<the address you chose>:8082/app/`. Include the `https://` and
   the `/app/`.
2. Your browser will warn that the connection is not private. Verity uses a
   certificate it created on your server rather than one from a public
   authority. The iPhone and iPad app checks that certificate against the
   pairing link; a browser cannot, so do this first sign-in only on a network
   you trust, such as your home network or Tailscale. Confirm that the
   address in the bar is your server, then choose the option to continue
   (often behind "Advanced").
3. On the "Connect this browser" page, paste the full `verity://pair?` line
   from the terminal and continue.

**On an iPhone or iPad:**

1. Install Verity from your TestFlight invitation and open it.
2. Tap "Continue", then "Pair this device" and scan the QR code in the
   terminal. If the camera cannot read it, choose "Paste pairing code instead"
   and paste the `verity://pair?` line.

**What you should see:** a screen that asks you to create your password.

## Step 3: Create your master password

This password encrypts everything Verity stores for you on the server: your
AI provider logins and, later, GitHub keys. Choose it carefully and keep it
somewhere safe. Verity cannot recover it. Enter it twice and continue.

After a server restart, Verity asks for this password once before it can read
those secrets again. That is expected, not an error.

**What you should see:** a screen titled "AI providers".

## Step 4: Connect an AI provider

Pick one provider to start.

- **Claude:** tap "Connect Claude", then "Open Claude login page". Sign in
  with your Claude account and approve the request. Verity either detects the
  completed login by itself or asks you to paste the code Claude showed you;
  then tap "Connect Claude" again.
- **Codex:** the same flow with your ChatGPT account.
- **OpenCode:** enter the API base URL and API key of an OpenAI-compatible
  provider, then save.

For Claude and Codex, your account credential stays on the Core: agents never
see it, and their requests pass through a broker on the server that adds it.
An OpenCode API key is not covered by this; it is made available inside the
project sandbox.

**What you should see:** "Claude connected" or "Codex connected", and the
button "Open Verity" becomes active. Tap it.

## Step 5: Create a project and run your first session

1. On the home screen, tap "Add your first project".
2. Choose "Empty project", give it a name such as `my-first-project`, and tap
   "Create project". Verity prepares an isolated sandbox for it, which takes a
   minute the first time. A sandbox is a private container on your server
   where this project's agents work; nothing they do leaves it.
3. Open the project and start a new session. A session is one conversation
   with one agent, with its own copy of the project files.
4. Type a first task, for example:

   > Create a small Node.js web page that shows the current time, and tell me
   > how to start it.

**What you should see:** the agent replies, you can follow its tool activity
as it works, and it asks you before doing anything that needs permission.
Later sessions can run at the same time in the same project; each one works
on its own branch, so they do not interfere.

You are done with the setup. Everything below is optional.

## Optional: add your other devices

Each device gets its own access that you can revoke separately.

- **From the iPhone or iPad app:** Settings → Devices → "Pair another device"
  creates a new QR code and pairing link, valid for five minutes. Scan it on
  the other phone or tablet, or copy the link and paste it on the "Connect this
  browser" page of a browser.
- **From a browser:** Settings → Devices → "Add a device" creates an
  invitation code for another browser. iPhones and iPads pair from the
  installer or from another app, not from a browser.
- **Mac:** install the iPad app on an Apple-silicon Mac and pair it like an
  iPad.

A browser can sign out under Settings → Devices → "This browser".

## Optional: connect GitHub

Connect GitHub when you want agents to work on your existing repositories and
open pull requests. In Settings → Connections, choose GitHub and follow the
sign-in; you choose which repositories Verity may use. Afterwards, "New
project" offers "GitHub repository" next to "Empty project", and Verity shows
pull-request and CI status inside each session.

Other connections, such as Google Drive folders or secret managers, live in
the same place and are explained in the [connections guide](connections.md).

## If something goes wrong

| What you see                                                                 | What to do                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a Linux host is required`                                                   | You ran the command on a Mac or Windows machine. Run it on the Linux server, over SSH if it is remote.                                                                       |
| `amd64 or arm64 is required`                                                 | The machine's processor is not supported. Choose a standard x86-64 or ARM64 server.                                                                                           |
| `Docker 25 or newer is required` or `cannot reach the root Docker daemon`    | Install Docker from [docs.docker.com](https://docs.docker.com/engine/install/) or pick a server image with Docker preinstalled, then run the install command again.          |
| `the Docker Compose v2 plugin is required`                                   | Install the `docker-compose-plugin` package from Docker's repository; the Docker installation guide above includes it.                                                        |
| `root access is required`                                                    | Log in as `root` or as a user allowed to use `sudo`.                                                                                                                         |
| `tar is required` or similar for `flock`, `openssl`, `curl`, `jq`             | Run the install command again with `--install-missing` at the end, or install those packages with your package manager.                                                       |
| The browser shows a certificate or privacy warning                           | Expected on first use; see [step 2](#step-2-connect-your-first-device). If it appears again later on the same device, stop and check that you are on the right address.        |
| The browser page does not load at all                                        | Check the address: `https://`, the address chosen during installation, `:8082`, and `/app/`. If the server is on Tailscale, the browser's computer must be on Tailscale too.    |
| "Could not reach the server address in this pairing code"                    | Your device cannot reach the address you chose during installation. Connect it to the same network or to Tailscale, then run the installer again to get a new pairing link.   |
| "Invalid pairing code" or the code is more than 15 minutes old               | Run the install command again, choose "Repair this installation", and use the new link it prints.                                                                             |
| The AI provider sign-in never completes                                      | Tap "Copy code again" and paste the code on the provider's page in the browser that opened. Make sure you signed in to the account that holds the subscription.               |
| "Incorrect password" after a restart                                         | The master password is the one you created in step 3. Verity cannot reset it; without it, the stored provider logins must be connected again after a reinstall.               |
| The project stays in "preparing" for a long time                             | The first sandbox downloads a large image. Wait a few minutes. On a server with 8 GB of memory, lower the sandbox limit as described in the deployment guide.                 |

If you are stuck, open an issue at
[github.com/Heey-Global/verity/issues](https://github.com/Heey-Global/verity/issues)
and include the lines the installer printed before it stopped. Remove the QR
code and the `verity://pair?` line first: both let anyone pair with your
server while the link is valid.

## Where to go next

- [Documentation overview](README.md) lists the guides for using, running, and
  developing Verity.
- [Deployment guide](../deploy/README.md) covers updates, backups, resource
  limits, and securing a server that is reachable from the internet.
- [Security policy](../SECURITY.md) describes the security model and known
  limitations of the beta.
