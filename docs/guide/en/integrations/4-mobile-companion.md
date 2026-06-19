# The mobile companion

Specrails has a companion phone app so you can keep an eye on your rails while you're away from your desk — watch jobs run, see them finish, and stay in the loop without sitting in front of the dashboard.

## What it's for

The companion is a **monitoring** surface. It connects to your running Specrails desktop app over your local network and mirrors live project and job activity to your phone. Think of it as a glanceable window into the same rails you'd otherwise watch on the dashboard.

## Pairing your phone

Pairing is built around a **QR code** so you don't have to type anything fiddly:

1. Make sure your desktop Specrails app is running and your phone is on the **same local network** (same Wi-Fi).
2. In the desktop app, open the pairing screen to display a QR code.
3. In the companion app on your phone, scan that code.
4. The phone discovers the desktop app on the network and connects.

From then on the companion keeps a live connection and streams project lists and job updates as they happen.

## How the connection works

The desktop app advertises itself on your local network so the phone can find it, and the QR code carries the details the phone needs to connect securely. Everything stays on your local network — the companion talks directly to your machine, not through any cloud service.

Because it's local-network based, the two devices need to be reachable to each other. If pairing doesn't take:

- Confirm both devices are on the **same Wi-Fi** (and that the network doesn't isolate clients from each other).
- Make sure the desktop app is **running** when you scan.
- Re-open the pairing screen to refresh the QR code and try scanning again.

## What you'll see

Once paired, the companion surfaces your projects and their live job activity, so you get the same real-time rail updates that flow into the desktop dashboard — pushed to your phone as they occur. It's the easiest way to know the moment a long-running rail wraps up.

## Good to know

- **Monitoring first.** The companion is designed for keeping tabs on rails, not for driving the full desktop workflow from your phone.
- **Local only.** No account, no cloud relay — your machine and your phone, on your network.
- **Keep the desktop awake.** The companion mirrors a running desktop app; if your machine sleeps or the app closes, live updates pause until it's back.