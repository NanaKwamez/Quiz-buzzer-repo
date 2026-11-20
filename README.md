# Offline Quiz Buzzer

A LAN-only quiz buzzer for one laptop host and up to 12 phones. It uses Node.js,
Express, and Socket.IO and does not require a CDN or internet connection.

## Setup

1. Install Node.js 18 or newer.
2. In this folder run:

   ```bash
   npm install
   node server.js
   ```

3. Open the host page on the laptop using the local URL printed by the server
   (for example `http://192.168.1.20:3000`).
4. Click **START** to enable laptop audio.
5. Connect phones to the same Wi-Fi or hotspot, scan the QR code on the host
   screen, choose a team number, and join.

## HTTPS and voice setup

The app starts only in HTTPS mode. On startup it automatically creates a
self-signed certificate in `certs/` using the laptop's current local IP address
and caches it there. If the IP changes, the certificate is regenerated
automatically.

Open the HTTPS address printed in the terminal on the host laptop too. The first
time a phone or laptop opens it, tap or click **Advanced**, then **Proceed**
to accept the certificate warning. You must accept it on every phone before
microphone access can work.

Custom certificate paths can be supplied with `SSL_CERT` and `SSL_KEY`.

## Voice controls

Teams choose an optional group when joining. The host can block individual teams
or whole groups, mute all microphones, unblock all, enable push-to-talk, and
toggle “Only active team can speak.” The active team is enabled automatically;
Wrong promotes the next team; Correct, Reset, and Next disable all live mics.

The WebRTC connection is audio-only and uses local host candidates only. It does
not use public STUN or TURN servers. The host's **master volume** slider controls
incoming phone audio.

## Controls

- **Open Question** / Space: clear the round queue and enable buzzing.
- **Correct** / C: award configurable points to the active team and lock the round.
- **Wrong** / W: remove the active team and optionally subtract points, then promote
  the next team.
- **Reset / Next Question** / R: clear the queue and return to Waiting.
- **Reset All Scores**: set every team score to zero.
- **Kick team**: remove a team from the live scoreboard.

Teams are 1–12. Teams keep their number and score when their phone refreshes or
loses the connection. The server uses arrival time to rank simultaneous presses.

## Group sounds

Sounds are selected by group, not by team number. The host starts with `Form 1`,
`Form 2`, and `Form 3`, and the **Sounds** panel lets you preview each sound,
choose its generated tone or custom file, and enable group announcements.

To add custom sounds, create this folder in the repository if it does not exist:

```text
public/sounds/
```

Then copy your files into it with these exact names:

```text
public/sounds/form1.mp3
public/sounds/form2.mp3
public/sounds/form3.mp3
```

Restart `node server.js`, open the host page, and select **Custom** for the
matching group in the Sounds panel. If a custom file is missing or cannot play,
the app automatically uses its generated offline tone. To add more groups,
enter their names in the comma-separated Groups field; they receive generated
tones automatically and can later use files such as `form4.mp3`.

## If the Sounds or microphone controls are missing

The app is on a feature branch until it is merged into `main`. After cloning,
run:

```bat
git switch copilot/build-quiz-buzzer-web-app
git pull
npm install
node server.js
```

Open `/host.html` explicitly (for example `http://localhost:3000/host.html`)
and click **START** before testing audio. The **Sounds** panel and microphone
controls appear below the host controls. If custom files do not appear, confirm
that the filenames are lowercase and match `public\sounds\form1.mp3`,
`public\sounds\form2.mp3`, or `public\sounds\form3.mp3`. Restart the server
after adding files and press refresh with Ctrl+F5.

The server never starts over plain HTTP. Use only the HTTPS address printed at
startup. Running this app from an existing `main` branch may expose old files;
use the current feature branch.

The server can be changed to a different port with `PORT=4000 node server.js`.