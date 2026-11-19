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

## Optional team sounds

Place custom files in `public/sounds/` named `team1.mp3` through `team12.mp3`.
If a file is not present, the host plays a distinct generated Web Audio tone.

The server can be changed to a different port with `PORT=4000 node server.js`.